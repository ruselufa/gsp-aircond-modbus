import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import ModbusRTU from 'modbus-serial';
import { ModbusGateway } from './modbus.gateway';
import { DeviceState } from './device.types';

interface ModbusResponse {
	data: number[];
}

interface ModbusError extends Error {
	message: string;
}

interface ModbusRequest {
	id: string;
	deviceId: number;
	type: 'read' | 'write';
	register: number;
	value?: number;
	priority: 'high' | 'normal' | 'low';
	timestamp: number;
	retryCount?: number;
}

@Injectable()
export class ModbusService {
	private client: ModbusRTU;
	private readonly logger = new Logger(ModbusService.name);
	private isConnected = false;
	private readonly deviceIds = [5, 6, 7];
	private devicesState: Map<number, DeviceState>;
	private isPolling = false; // Флаг для предотвращения одновременного опроса

	// Очередь запросов для управления приоритетами
	private requestQueue: ModbusRequest[] = [];
	private isProcessingQueue = false;
	private currentDeviceId: number | null = null; // Текущее активное устройство
	private requestLock = false; // Блокировка для синхронизации

	// Настройки retry и таймаутов
	private readonly MAX_RETRIES = 3;
	private readonly REQUEST_TIMEOUT = 5000; // 5 секунд
	private readonly DEVICE_SWITCH_DELAY = 200; // 200ms между переключениями устройств
	private readonly REQUEST_DELAY = 100; // 100ms между запросами

	// Статистика работы master'а
	private masterStats = {
		totalRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		averageResponseTime: 0,
		lastRequestTime: 0,
		connectionErrors: 0,
		timeoutErrors: 0,
		deviceConflicts: 0,
	};

	constructor(
		@Inject(forwardRef(() => ModbusGateway))
		private readonly modbusGateway: ModbusGateway,
	) {
		this.client = new ModbusRTU();
		this.devicesState = new Map();
		this.initializeDevices();
		this.connect();
		this.startQueueProcessor();
	}

	private initializeDevices() {
		this.deviceIds.forEach((deviceId) => {
			this.devicesState.set(deviceId, this.getInitialState(deviceId));
		});
	}

	private getInitialState(deviceId: number): DeviceState {
		return {
			id: `AC_${deviceId}`,
			name: `Кондиционер 5${deviceId}`,
			isOnline: false,
			mode: '',
			isOn: false,
			setTemperature: 0,
			fanSpeed: 0,
			temperature: 0,
			waterTemperature: 0,
			pumpStatus: false,
			valveStatus: false,
			errors: {
				tempSensorError: false,
				waterTempSensor1Error: false,
				waterTempSensor2Error: false,
				fanSpeedError: false,
				pumpError: false,
			},
			protectionState: 0,
		};
	}

	private convertMode(mode: number): string {
		switch (mode) {
			case 0:
				return 'Выключен';
			case 1:
				return 'Охлаждение';
			case 2:
				return 'Обогрев';
			case 3:
				return 'Вентиляция';
			case 4:
				return 'Авто';
			default:
				return 'Неизвестно';
		}
	}

	private async connect() {
		try {
			// Улучшенная настройка TCP соединения для master'а
			await this.client.connectTCP('192.168.1.162', {
				port: 502,
				timeout: 10000, // увеличиваем таймаут соединения
			});

			// Настройка параметров master'а
			this.client.setTimeout(this.REQUEST_TIMEOUT); // таймаут для операций

			this.isConnected = true;
			this.logger.log('✅ Modbus Master успешно подключен к сети');
		} catch (error) {
			const modbusError = error as ModbusError;
			this.logger.error(`❌ Ошибка подключения Modbus Master: ${modbusError.message}`);
			this.isConnected = false;
			this.masterStats.connectionErrors++;
		}
	}

	/**
	 * Синхронизированное переключение на устройство
	 */
	private async switchToDevice(deviceId: number): Promise<boolean> {
		if (this.requestLock) {
			this.logger.warn(`[${deviceId}] Запрос заблокирован, ожидание...`);
			return false;
		}

		if (this.currentDeviceId === deviceId) {
			return true; // уже на нужном устройстве
		}

		this.requestLock = true;
		try {
			// Ждем завершения предыдущих операций
			await this.timeout(this.DEVICE_SWITCH_DELAY);

			this.client.setID(deviceId);
			this.currentDeviceId = deviceId;

			this.logger.debug(`[${deviceId}] Переключились на устройство`);
			return true;
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка переключения на устройство: ${error}`);
			return false;
		} finally {
			this.requestLock = false;
		}
	}

	/**
	 * Безопасное выполнение Modbus операции с retry
	 */
	private async executeModbusOperation<T>(
		deviceId: number,
		operation: () => Promise<T>,
		operationName: string,
	): Promise<T | null> {
		for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
			try {
				// Переключаемся на устройство
				const switched = await this.switchToDevice(deviceId);
				if (!switched) {
					this.logger.warn(
						`[${deviceId}] Не удалось переключиться на устройство для ${operationName}`,
					);
					return null;
				}

				// Ждем между запросами
				if (attempt > 0) {
					await this.timeout(this.REQUEST_DELAY * (attempt + 1));
				}

				const startTime = Date.now();
				const result = await operation();
				const responseTime = Date.now() - startTime;

				// Обновляем статистику
				this.updateMasterStats(true, responseTime);

				if (attempt > 0) {
					this.logger.log(`[${deviceId}] ${operationName} успешно после ${attempt + 1} попытки`);
				}

				return result;
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);

				// Анализируем тип ошибки
				if (
					errorMessage.includes('Unexpected data error') ||
					errorMessage.includes('expected address')
				) {
					this.masterStats.deviceConflicts++;
					this.logger.warn(`[${deviceId}] Конфликт устройств в ${operationName}: ${errorMessage}`);
				} else if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
					this.masterStats.timeoutErrors++;
					this.logger.warn(`[${deviceId}] Таймаут в ${operationName}: ${errorMessage}`);
				} else {
					this.logger.error(`[${deviceId}] Ошибка в ${operationName}: ${errorMessage}`);
				}

				this.updateMasterStats(false, 0);

				// Если это последняя попытка, логируем ошибку
				if (attempt === this.MAX_RETRIES) {
					this.logger.error(
						`[${deviceId}] ${operationName} не удалось после ${this.MAX_RETRIES + 1} попыток`,
					);
					return null;
				}

				// Ждем перед повторной попыткой
				await this.timeout(this.REQUEST_DELAY * (attempt + 2));
			}
		}

		return null;
	}

	/**
	 * Запуск обработчика очереди запросов
	 */
	private startQueueProcessor() {
		setInterval(async () => {
			if (!this.isProcessingQueue && this.requestQueue.length > 0) {
				await this.processRequestQueue();
			}
		}, 100); // проверяем очередь каждые 100ms
	}

	/**
	 * Обработка очереди запросов с приоритетами
	 */
	private async processRequestQueue() {
		if (this.isProcessingQueue || this.requestQueue.length === 0) return;

		this.isProcessingQueue = true;

		try {
			// Сортируем запросы по приоритету и времени
			this.requestQueue.sort((a, b) => {
				const priorityOrder = { high: 3, normal: 2, low: 1 };
				const aPriority = priorityOrder[a.priority];
				const bPriority = priorityOrder[b.priority];

				if (aPriority !== bPriority) {
					return bPriority - aPriority; // высокий приоритет первым
				}

				return a.timestamp - b.timestamp; // FIFO для одинакового приоритета
			});

			const request = this.requestQueue.shift();
			if (!request) return;

			this.logger.debug(
				`🔧 Обрабатываем запрос: ${request.type} register ${request.register} device ${request.deviceId} (${request.priority} priority)`,
			);

			const startTime = Date.now();
			let success = false;

			try {
				if (request.type === 'read') {
					const result = await this.executeModbusOperation(
						request.deviceId,
						() => this.client.readHoldingRegisters(request.register, 1),
						`чтение регистра ${request.register}`,
					);
					success = result !== null;
					if (success && result) {
						this.logger.debug(`📖 Успешно прочитан регистр ${request.register}: ${result.data[0]}`);
					}
				} else if (request.type === 'write' && request.value !== undefined) {
					const result = await this.executeModbusOperation(
						request.deviceId,
						() => this.client.writeRegister(request.register, request.value!),
						`запись регистра ${request.register}`,
					);
					success = result !== null;
					if (success) {
						this.logger.debug(`✏️ Успешно записан регистр ${request.register}: ${request.value}`);
					}
				}
			} catch (error) {
				this.logger.error(`❌ Ошибка обработки запроса: ${error}`);
			}
		} finally {
			this.isProcessingQueue = false;
		}
	}

	/**
	 * Обновление статистики master'а
	 */
	private updateMasterStats(success: boolean, responseTime: number) {
		this.masterStats.totalRequests++;
		this.masterStats.lastRequestTime = Date.now();

		if (success) {
			this.masterStats.successfulRequests++;
			// Обновляем среднее время ответа
			const totalTime =
				this.masterStats.averageResponseTime * (this.masterStats.successfulRequests - 1) +
				responseTime;
			this.masterStats.averageResponseTime = totalTime / this.masterStats.successfulRequests;
		} else {
			this.masterStats.failedRequests++;
		}
	}

	/**
	 * Добавление запроса в очередь
	 */
	private addToQueue(request: Omit<ModbusRequest, 'id' | 'timestamp'>): string {
		const id = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		const queueRequest: ModbusRequest = {
			...request,
			id,
			timestamp: Date.now(),
			retryCount: 0,
		};

		this.requestQueue.push(queueRequest);
		this.logger.debug(
			`📋 Добавлен запрос в очередь: ${id} (${request.type} ${request.register} device ${request.deviceId})`,
		);
		return id;
	}

	/**
	 * Пакетное чтение регистров для оптимизации
	 */
	async readRegistersBatch(deviceId: number, registers: number[]): Promise<Map<number, number>> {
		const results = new Map<number, number>();

		try {
			const switched = await this.switchToDevice(deviceId);
			if (!switched) {
				this.logger.warn(
					`[${deviceId}] Не удалось переключиться на устройство для пакетного чтения`,
				);
				return results;
			}

			// Группируем последовательные регистры для оптимизации
			const sortedRegisters = [...registers].sort((a, b) => a - b);
			let currentGroup: number[] = [];
			const groups: number[][] = [];

			for (let i = 0; i < sortedRegisters.length; i++) {
				if (
					currentGroup.length === 0 ||
					sortedRegisters[i] === currentGroup[currentGroup.length - 1] + 1
				) {
					currentGroup.push(sortedRegisters[i]);
				} else {
					groups.push([...currentGroup]);
					currentGroup = [sortedRegisters[i]];
				}
			}
			if (currentGroup.length > 0) {
				groups.push(currentGroup);
			}

			// Читаем группы регистров
			for (const group of groups) {
				const startRegister = group[0];
				const count = group.length;

				const result = await this.executeModbusOperation(
					deviceId,
					() => this.client.readHoldingRegisters(startRegister, count),
					`пакетное чтение регистров ${startRegister}-${startRegister + count - 1}`,
				);

				if (result) {
					group.forEach((register, index) => {
						results.set(register, result.data[index]);
					});
				}
			}
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка пакетного чтения: ${error}`);
		}

		return results;
	}

	/**
	 * Получение статистики работы master'а
	 */
	getMasterStats() {
		const successRate =
			this.masterStats.totalRequests > 0
				? ((this.masterStats.successfulRequests / this.masterStats.totalRequests) * 100).toFixed(2)
				: '0.00';

		return {
			...this.masterStats,
			successRate: `${successRate}%`,
			queueLength: this.requestQueue.length,
			currentDevice: this.currentDeviceId,
			isProcessing: this.isProcessingQueue,
			connectionStatus: this.isConnected,
		};
	}

	/**
	 * Проверка доступности устройства с улучшенной диагностикой
	 */
	async checkDeviceAvailability(deviceId: number): Promise<boolean> {
		try {
			this.logger.log(`[${deviceId}] Проверка доступности устройства...`);

			// Пытаемся прочитать простой регистр для проверки связи с таймаутом
			const res: ModbusResponse = (await Promise.race([
				this.client.readHoldingRegisters(1601, 1),
				new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)),
			])) as ModbusResponse;

			this.logger.log(`[${deviceId}] Устройство доступно, получен ответ: ${res.data[0]}`);
			return true;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`[${deviceId}] Устройство недоступно: ${errorMessage}`);
			return false;
		}
	}

	// --- Автоматический опрос устройств ---
	@Interval(10000) // Опрос каждые 10 секунд
	async pollDevices() {
		// Проверяем, не выполняется ли уже опрос
		if (this.isPolling) {
			this.logger.warn('Опрос уже выполняется, пропускаем этот цикл');
			return;
		}

		if (!this.isConnected) {
			await this.connect();
			if (!this.isConnected) {
				this.modbusGateway.broadcastError('Устройство недоступно');
				return;
			}
		}

		this.isPolling = true; // Устанавливаем флаг
		const updatedDevices: DeviceState[] = [];

		this.logger.log(`Начинаем опрос устройств: ${this.deviceIds.join(', ')}`);

		try {
			for (const deviceId of this.deviceIds) {
				this.logger.log(`=== Начало опроса устройства ${deviceId} ===`);
				this.logger.log(
					`[${deviceId}] Обработка устройства ${deviceId} из списка: ${this.deviceIds.join(', ')}`,
				);

				// Сначала проверяем доступность устройства
				const isAvailable = await this.checkDeviceAvailability(deviceId);
				if (!isAvailable) {
					this.logger.log(`[${deviceId}] Устройство недоступно, пропускаем опрос`);
					const offlineState = {
						...this.devicesState.get(deviceId)!,
						isOnline: false,
					};
					this.devicesState.set(deviceId, offlineState);
					updatedDevices.push(offlineState);
					continue;
				}

				try {
					this.logger.log(`[${deviceId}] Устанавливаем ID устройства...`);
					this.client.setID(deviceId);

					this.logger.log(`[${deviceId}] Читаем режим работы...`);
					const mode = await this.getOperatingMode(deviceId);
					await this.timeout(200);

					this.logger.log(`[${deviceId}] Читаем уставку температуры...`);
					const temp = await this.getTemperatureSetpoint(deviceId);
					await this.timeout(200);

					this.logger.log(`[${deviceId}] Читаем скорость вентилятора...`);
					const speed = await this.getFanSpeed(deviceId);
					await this.timeout(200);

					this.logger.log(`[${deviceId}] Читаем температуру воздуха...`);
					const airTemp = await this.getAirTemperature(deviceId);
					await this.timeout(200);

					this.logger.log(`[${deviceId}] Читаем температуру воды...`);
					const waterTemp = await this.getWaterTemperature(deviceId);
					await this.timeout(200);

					this.logger.log(`[${deviceId}] Читаем статус помпы...`);
					const pumpStatus = await this.getPumpStatus(deviceId);
					await this.timeout(200);

					this.logger.log(`[${deviceId}] Читаем статус клапана...`);
					const valveStatus = await this.getValveStatus(deviceId);
					await this.timeout(200);

					this.logger.log(`[${deviceId}] Читаем ошибки...`);
					const errors = await this.getErrors(deviceId);
					await this.timeout(200);

					this.logger.log(`[${deviceId}] Читаем состояние защиты...`);
					const protection = await this.getProtectionState(deviceId);
					await this.timeout(200);

					const updatedState: DeviceState = {
						...this.devicesState.get(deviceId)!,
						isOnline: true,
						mode: mode !== null ? this.convertMode(mode) : '',
						isOn: mode !== null && mode > 0,
						setTemperature: temp || 0,
						fanSpeed: speed || 0,
						temperature: airTemp || 0,
						waterTemperature: waterTemp || 0,
						pumpStatus: pumpStatus || false,
						valveStatus: valveStatus || false,
						errors: errors || this.devicesState.get(deviceId)!.errors,
						protectionState: protection || 0,
					};

					this.devicesState.set(deviceId, updatedState);
					updatedDevices.push(updatedState);

					this.logger.log(
						`[${deviceId}] Успешно: режим=${mode}, уставка=${temp}, скорость=${speed}, ` +
							`темп.воздуха=${airTemp}, темп.воды=${waterTemp}, помпа=${pumpStatus}, клапан=${valveStatus}, ` +
							`ошибки=${JSON.stringify(errors)}, защита=${protection}`,
					);
				} catch (error) {
					this.logger.error(`[${deviceId}] Критическая ошибка при опросе устройства: ${error}`);
					const offlineState = {
						...this.devicesState.get(deviceId)!,
						isOnline: false,
					};
					this.devicesState.set(deviceId, offlineState);
					updatedDevices.push(offlineState);
				}

				this.logger.log(`=== Конец опроса устройства ${deviceId} ===`);
				await this.timeout(500); // увеличиваем задержку между опросами
			}

			this.logger.log(
				`Завершен опрос всех устройств. Обновлено: ${updatedDevices.length} устройств`,
			);
			this.modbusGateway.broadcastDevicesState(updatedDevices);
		} catch (error) {
			this.logger.error(`Критическая ошибка в pollDevices: ${error}`);
		} finally {
			this.isPolling = false; // Сбрасываем флаг в любом случае
		}
	}

	// Timeout promise function
	private async timeout(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// --- Методы чтения с улучшенной обработкой ошибок ---
	async getOperatingMode(deviceId: number): Promise<number | null> {
		return this.executeModbusOperation(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение режима работы (1601)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1601, 1);
				this.logger.debug(`[${deviceId}] Режим работы: ${res.data[0]}`);
				return res;
			},
			'чтение режима работы',
		).then((result) => result?.data[0] ?? null);
	}

	async getTemperatureSetpoint(deviceId: number): Promise<number | null> {
		return this.executeModbusOperation(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение уставки температуры (1602)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1602, 1);
				this.logger.debug(`[${deviceId}] Уставка температуры: ${res.data[0]}`);
				return res;
			},
			'чтение уставки температуры',
		).then((result) => result?.data[0] ?? null);
	}

	async getFanSpeed(deviceId: number): Promise<number | null> {
		return this.executeModbusOperation(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение скорости вентилятора (1603)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1603, 1);
				this.logger.debug(`[${deviceId}] Скорость вентилятора: ${res.data[0]}`);
				return res;
			},
			'чтение скорости вентилятора',
		).then((result) => result?.data[0] ?? null);
	}

	async getAirTemperature(deviceId: number): Promise<number | null> {
		return this.executeModbusOperation(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение температуры воздуха (1606)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1606, 1);
				const temp = res.data[0] * 0.5 - 20;
				this.logger.debug(`[${deviceId}] Температура воздуха: ${temp}°C (raw: ${res.data[0]})`);
				return { ...res, temp };
			},
			'чтение температуры воздуха',
		).then((result) => result?.temp ?? null);
	}

	async getWaterTemperature(deviceId: number): Promise<number | null> {
		return this.executeModbusOperation(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение температуры воды (1607)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1607, 1);
				const temp = res.data[0] * 0.5 - 20;
				this.logger.debug(`[${deviceId}] Температура воды: ${temp}°C (raw: ${res.data[0]})`);
				return { ...res, temp };
			},
			'чтение температуры воды',
		).then((result) => result?.temp ?? null);
	}

	async getPumpStatus(deviceId: number): Promise<boolean | null> {
		return this.executeModbusOperation(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение статуса помпы (1613)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1613, 1);
				const status = (res.data[0] & 0x01) !== 0;
				this.logger.debug(`[${deviceId}] Статус помпы: ${status} (raw: ${res.data[0]})`);
				return { ...res, status };
			},
			'чтение статуса помпы',
		).then((result) => result?.status ?? null);
	}

	async getValveStatus(deviceId: number): Promise<boolean | null> {
		return this.executeModbusOperation(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение статуса клапана (1619)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1619, 1);
				const status = (res.data[0] & (1 << 9)) !== 0;
				this.logger.debug(`[${deviceId}] Статус клапана: ${status} (raw: ${res.data[0]})`);
				return { ...res, status };
			},
			'чтение статуса клапана',
		).then((result) => result?.status ?? null);
	}

	async getErrors(deviceId: number): Promise<DeviceState['errors'] | null> {
		return this.executeModbusOperation(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение ошибок (1614)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1614, 1);
				const errors = {
					tempSensorError: (res.data[0] & (1 << 2)) !== 0,
					waterTempSensor1Error: (res.data[0] & (1 << 3)) !== 0,
					waterTempSensor2Error: (res.data[0] & (1 << 4)) !== 0,
					fanSpeedError: (res.data[0] & (1 << 8)) !== 0,
					pumpError: (res.data[0] & (1 << 14)) !== 0,
				};
				this.logger.debug(`[${deviceId}] Ошибки: ${JSON.stringify(errors)} (raw: ${res.data[0]})`);
				return { ...res, errors };
			},
			'чтение ошибок',
		).then((result) => result?.errors ?? null);
	}

	async getProtectionState(deviceId: number): Promise<number | null> {
		return this.executeModbusOperation(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение состояния защиты (1614)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1614, 1);
				this.logger.debug(`[${deviceId}] Состояние защиты: ${res.data[0]}`);
				return res;
			},
			'чтение состояния защиты',
		).then((result) => result?.data[0] ?? null);
	}

	getCurrentDevicesState(): DeviceState[] {
		return Array.from(this.devicesState.values());
	}

	// --- Методы записи с валидацией ---

	/**
	 * Немедленное обновление состояния конкретного устройства
	 * Вызывается после записи для получения актуального состояния
	 */
	async updateDeviceStateImmediately(deviceId: number): Promise<DeviceState | null> {
		try {
			this.logger.log(`[${deviceId}] Немедленное обновление состояния устройства...`);

			// Проверяем доступность устройства
			const isAvailable = await this.checkDeviceAvailability(deviceId);
			if (!isAvailable) {
				this.logger.warn(`[${deviceId}] Устройство недоступно для немедленного обновления`);
				return null;
			}

			// Быстрое чтение основных параметров
			const mode = await this.getOperatingMode(deviceId);
			const temp = await this.getTemperatureSetpoint(deviceId);
			const speed = await this.getFanSpeed(deviceId);
			const airTemp = await this.getAirTemperature(deviceId);
			const waterTemp = await this.getWaterTemperature(deviceId);
			const pumpStatus = await this.getPumpStatus(deviceId);
			const valveStatus = await this.getValveStatus(deviceId);
			const errors = await this.getErrors(deviceId);
			const protection = await this.getProtectionState(deviceId);

			const updatedState: DeviceState = {
				...this.devicesState.get(deviceId)!,
				isOnline: true,
				mode: mode !== null ? this.convertMode(mode) : '',
				isOn: mode !== null && mode > 0,
				setTemperature: temp || 0,
				fanSpeed: speed || 0,
				temperature: airTemp || 0,
				waterTemperature: waterTemp || 0,
				pumpStatus: pumpStatus || false,
				valveStatus: valveStatus || false,
				errors: errors || this.devicesState.get(deviceId)!.errors,
				protectionState: protection || 0,
			};

			this.devicesState.set(deviceId, updatedState);

			// Немедленно отправляем обновленное состояние через WebSocket
			this.modbusGateway.broadcastDevicesState([updatedState]);

			this.logger.log(`[${deviceId}] Состояние немедленно обновлено и отправлено`);
			return updatedState;
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка немедленного обновления состояния: ${error}`);
			return null;
		}
	}

	/**
	 * Приоритетное чтение регистра через очередь
	 */
	async readRegisterWithPriority(
		deviceId: number,
		register: number,
		priority: 'high' | 'normal' | 'low' = 'normal',
	): Promise<number | null> {
		return new Promise((resolve) => {
			const requestId = this.addToQueue({
				deviceId,
				type: 'read',
				register,
				priority,
			});

			// Проверяем результат через интервал
			const checkResult = () => {
				// Здесь должна быть логика проверки результата из очереди
				// Пока возвращаем null для совместимости
				resolve(null);
			};

			// Проверяем каждые 100ms в течение 10 секунд
			let attempts = 0;
			const maxAttempts = 100;
			const interval = setInterval(() => {
				attempts++;
				if (attempts >= maxAttempts) {
					clearInterval(interval);
					resolve(null);
				}
				checkResult();
			}, 100);
		});
	}

	/**
	 * Приоритетная запись регистра через очередь
	 */
	async writeRegisterWithPriority(
		deviceId: number,
		register: number,
		value: number,
		priority: 'high' | 'normal' | 'low' = 'normal',
	): Promise<boolean> {
		return new Promise((resolve) => {
			const requestId = this.addToQueue({
				deviceId,
				type: 'write',
				register,
				value,
				priority,
			});

			// Проверяем результат через интервал
			const checkResult = () => {
				// Здесь должна быть логика проверки результата из очереди
				// Пока возвращаем false для совместимости
				resolve(false);
			};

			// Проверяем каждые 100ms в течение 10 секунд
			let attempts = 0;
			const maxAttempts = 100;
			const interval = setInterval(() => {
				attempts++;
				if (attempts >= maxAttempts) {
					clearInterval(interval);
					resolve(false);
				}
				checkResult();
			}, 100);
		});
	}

	// --- Методы записи с улучшенной обработкой ошибок ---

	/**
	 * Установка режима работы с подтверждением
	 */
	async setOperatingMode(deviceId: number, mode: number): Promise<boolean> {
		try {
			this.logger.log(`[${deviceId}] Установка режима работы: ${mode}`);

			// Записываем значение
			const writeResult = await this.executeModbusOperation(
				deviceId,
				() => this.client.writeRegister(1601, mode),
				`запись режима работы ${mode}`,
			);

			if (!writeResult) {
				this.logger.error(`[${deviceId}] Не удалось записать режим работы`);
				return false;
			}

			// Подтверждаем запись чтением обратно
			await this.timeout(100);
			const readResult = await this.getOperatingMode(deviceId);

			if (readResult === mode) {
				this.logger.log(`[${deviceId}] Режим работы успешно установлен: ${mode}`);

				// Немедленно обновляем состояние
				await this.updateDeviceStateImmediately(deviceId);

				return true;
			} else {
				this.logger.error(
					`[${deviceId}] Ошибка подтверждения записи режима: ожидалось ${mode}, получено ${readResult}`,
				);
				return false;
			}
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка установки режима работы: ${error}`);
			return false;
		}
	}

	/**
	 * Установка уставки температуры с подтверждением
	 */
	async setTemperatureSetpoint(deviceId: number, temperature: number): Promise<boolean> {
		try {
			this.logger.log(`[${deviceId}] Установка уставки температуры: ${temperature}°C`);

			// Проверяем диапазон
			if (temperature < 16 || temperature > 30) {
				this.logger.error(`[${deviceId}] Уставка температуры вне диапазона: ${temperature}°C`);
				return false;
			}

			// Записываем значение
			const writeResult = await this.executeModbusOperation(
				deviceId,
				() => this.client.writeRegister(1602, temperature),
				`запись уставки температуры ${temperature}`,
			);

			if (!writeResult) {
				this.logger.error(`[${deviceId}] Не удалось записать уставку температуры`);
				return false;
			}

			// Подтверждаем запись чтением обратно
			await this.timeout(100);
			const readResult = await this.getTemperatureSetpoint(deviceId);

			if (readResult === temperature) {
				this.logger.log(`[${deviceId}] Уставка температуры успешно установлена: ${temperature}°C`);

				// Немедленно обновляем состояние
				await this.updateDeviceStateImmediately(deviceId);

				return true;
			} else {
				this.logger.error(
					`[${deviceId}] Ошибка подтверждения записи уставки: ожидалось ${temperature}, получено ${readResult}`,
				);
				return false;
			}
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка установки уставки температуры: ${error}`);
			return false;
		}
	}

	/**
	 * Установка скорости вентилятора с подтверждением
	 */
	async setFanSpeed(deviceId: number, speed: number): Promise<boolean> {
		try {
			this.logger.log(`[${deviceId}] Установка скорости вентилятора: ${speed}`);

			// Проверяем диапазон
			if (speed < 0 || speed > 4) {
				this.logger.error(`[${deviceId}] Скорость вентилятора вне диапазона: ${speed}`);
				return false;
			}

			// Записываем значение
			const writeResult = await this.executeModbusOperation(
				deviceId,
				() => this.client.writeRegister(1603, speed),
				`запись скорости вентилятора ${speed}`,
			);

			if (!writeResult) {
				this.logger.error(`[${deviceId}] Не удалось записать скорость вентилятора`);
				return false;
			}

			// Подтверждаем запись чтением обратно
			await this.timeout(100);
			const readResult = await this.getFanSpeed(deviceId);

			if (readResult === speed) {
				this.logger.log(`[${deviceId}] Скорость вентилятора успешно установлена: ${speed}`);

				// Немедленно обновляем состояние
				await this.updateDeviceStateImmediately(deviceId);

				return true;
			} else {
				this.logger.error(
					`[${deviceId}] Ошибка подтверждения записи скорости: ожидалось ${speed}, получено ${readResult}`,
				);
				return false;
			}
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка установки скорости вентилятора: ${error}`);
			return false;
		}
	}

	/**
	 * Управление питанием с подтверждением
	 */
	async setPowerState(deviceId: number, isOn: boolean): Promise<boolean> {
		try {
			const mode = isOn ? 2 : 0; // 2 = обогрев, 0 = выключен
			this.logger.log(
				`[${deviceId}] Управление питанием: ${isOn ? 'включить' : 'выключить'} (режим: ${mode})`,
			);

			return await this.setOperatingMode(deviceId, mode);
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка управления питанием: ${error}`);
			return false;
		}
	}

	/**
	 * Получение расширенной диагностики сети
	 */
	getNetworkDiagnostics() {
		return {
			connection: {
				isConnected: this.isConnected,
				currentDevice: this.currentDeviceId,
				requestLock: this.requestLock,
			},
			queue: {
				length: this.requestQueue.length,
				isProcessing: this.isProcessingQueue,
				nextRequest: this.requestQueue[0] || null,
			},
			performance: {
				successRate:
					(this.masterStats.successfulRequests / Math.max(this.masterStats.totalRequests, 1)) * 100,
				averageResponseTime: this.masterStats.averageResponseTime,
				lastRequestTime: this.masterStats.lastRequestTime,
			},
			errors: {
				totalErrors: this.masterStats.failedRequests,
				connectionErrors: this.masterStats.connectionErrors,
				timeoutErrors: this.masterStats.timeoutErrors,
				deviceConflicts: this.masterStats.deviceConflicts,
			},
		};
	}

	/**
	 * Сброс статистики и очистка очереди
	 */
	resetStats() {
		this.masterStats = {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			averageResponseTime: 0,
			lastRequestTime: 0,
			connectionErrors: 0,
			timeoutErrors: 0,
			deviceConflicts: 0,
		};
		this.requestQueue = [];
		this.currentDeviceId = null;
		this.requestLock = false;
		this.logger.log('📊 Статистика и очередь сброшены');
	}
}

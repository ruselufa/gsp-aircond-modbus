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

@Injectable()
export class ModbusServiceImproved {
	private client: ModbusRTU;
	private readonly logger = new Logger(ModbusServiceImproved.name);
	private isConnected = false;
	private readonly deviceIds = [5, 6, 7];
	private devicesState: Map<number, DeviceState>;

	// Синхронизация запросов
	private currentDeviceId: number | null = null;
	private requestLock = false;
	private requestQueue: Array<() => Promise<any>> = [];
	private isProcessingQueue = false;

	// Настройки retry и таймаутов
	private readonly MAX_RETRIES = 3;
	private readonly REQUEST_TIMEOUT = 5000;
	private readonly DEVICE_SWITCH_DELAY = 200;
	private readonly REQUEST_DELAY = 100;

	// Статистика
	private masterStats = {
		totalRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		deviceConflicts: 0,
		timeoutErrors: 0,
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
			case 0: return 'Выключен';
			case 1: return 'Охлаждение';
			case 2: return 'Обогрев';
			case 3: return 'Вентиляция';
			case 4: return 'Авто';
			default: return 'Неизвестно';
		}
	}

	private async connect() {
		try {
			await this.client.connectTCP('192.168.1.162', {
				port: 502,
				timeout: 10000,
			});
			this.client.setTimeout(this.REQUEST_TIMEOUT);
			this.isConnected = true;
			this.logger.log('✅ Modbus Master подключен');
		} catch (error) {
			this.logger.error(`❌ Ошибка подключения: ${error}`);
			this.isConnected = false;
		}
	}

	/**
	 * Синхронизированное переключение на устройство
	 */
	private async switchToDevice(deviceId: number): Promise<boolean> {
		if (this.requestLock) {
			return false;
		}

		if (this.currentDeviceId === deviceId) {
			return true;
		}

		this.requestLock = true;
		try {
			await this.timeout(this.DEVICE_SWITCH_DELAY);
			this.client.setID(deviceId);
			this.currentDeviceId = deviceId;
			return true;
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка переключения: ${error}`);
			return false;
		} finally {
			this.requestLock = false;
		}
	}

	/**
	 * Безопасное выполнение операции с retry
	 */
	private async executeWithRetry<T>(
		deviceId: number,
		operation: () => Promise<T>,
		operationName: string
	): Promise<T | null> {
		for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
			try {
				const switched = await this.switchToDevice(deviceId);
				if (!switched) {
					this.logger.warn(`[${deviceId}] Не удалось переключиться для ${operationName}`);
					return null;
				}

				if (attempt > 0) {
					await this.timeout(this.REQUEST_DELAY * (attempt + 1));
				}

				const result = await operation();
				this.updateStats(true);
				return result;

			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);

				if (errorMessage.includes('Unexpected data error') || errorMessage.includes('expected address')) {
					this.masterStats.deviceConflicts++;
					this.logger.warn(`[${deviceId}] Конфликт устройств в ${operationName}`);
				} else if (errorMessage.includes('timeout')) {
					this.masterStats.timeoutErrors++;
					this.logger.warn(`[${deviceId}] Таймаут в ${operationName}`);
				}

				this.updateStats(false);

				if (attempt === this.MAX_RETRIES) {
					this.logger.error(`[${deviceId}] ${operationName} не удалось после ${this.MAX_RETRIES + 1} попыток`);
					return null;
				}

				await this.timeout(this.REQUEST_DELAY * (attempt + 2));
			}
		}
		return null;
	}

	private updateStats(success: boolean) {
		this.masterStats.totalRequests++;
		if (success) {
			this.masterStats.successfulRequests++;
		} else {
			this.masterStats.failedRequests++;
		}
	}

	private startQueueProcessor() {
		setInterval(async () => {
			if (!this.isProcessingQueue && this.requestQueue.length > 0) {
				await this.processQueue();
			}
		}, 50);
	}

	private async processQueue() {
		if (this.isProcessingQueue || this.requestQueue.length === 0) return;

		this.isProcessingQueue = true;
		try {
			const operation = this.requestQueue.shift();
			if (operation) {
				await operation();
			}
		} finally {
			this.isProcessingQueue = false;
		}
	}

	private addToQueue(operation: () => Promise<any>) {
		this.requestQueue.push(operation);
	}

	private async timeout(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// Методы чтения с улучшенной обработкой ошибок
	async getOperatingMode(deviceId: number): Promise<number | null> {
		return this.executeWithRetry(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение режима работы (1601)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1601, 1);
				this.logger.debug(`[${deviceId}] Режим работы: ${res.data[0]}`);
				return res.data[0];
			},
			'чтение режима работы'
		);
	}

	async getTemperatureSetpoint(deviceId: number): Promise<number | null> {
		return this.executeWithRetry(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение уставки температуры (1602)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1602, 1);
				this.logger.debug(`[${deviceId}] Уставка температуры: ${res.data[0]}`);
				return res.data[0];
			},
			'чтение уставки температуры'
		);
	}

	async getFanSpeed(deviceId: number): Promise<number | null> {
		return this.executeWithRetry(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение скорости вентилятора (1603)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1603, 1);
				this.logger.debug(`[${deviceId}] Скорость вентилятора: ${res.data[0]}`);
				return res.data[0];
			},
			'чтение скорости вентилятора'
		);
	}

	async getAirTemperature(deviceId: number): Promise<number | null> {
		return this.executeWithRetry(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение температуры воздуха (1606)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1606, 1);
				const temp = res.data[0] * 0.5 - 20;
				this.logger.debug(`[${deviceId}] Температура воздуха: ${temp}°C (raw: ${res.data[0]})`);
				return temp;
			},
			'чтение температуры воздуха'
		);
	}

	async getWaterTemperature(deviceId: number): Promise<number | null> {
		return this.executeWithRetry(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение температуры воды (1607)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1607, 1);
				const temp = res.data[0] * 0.5 - 20;
				this.logger.debug(`[${deviceId}] Температура воды: ${temp}°C (raw: ${res.data[0]})`);
				return temp;
			},
			'чтение температуры воды'
		);
	}

	async getPumpStatus(deviceId: number): Promise<boolean | null> {
		return this.executeWithRetry(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение статуса помпы (1613)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1613, 1);
				const status = (res.data[0] & 0x01) !== 0;
				this.logger.debug(`[${deviceId}] Статус помпы: ${status} (raw: ${res.data[0]})`);
				return status;
			},
			'чтение статуса помпы'
		);
	}

	async getValveStatus(deviceId: number): Promise<boolean | null> {
		return this.executeWithRetry(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение статуса клапана (1619)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1619, 1);
				const status = (res.data[0] & (1 << 9)) !== 0;
				this.logger.debug(`[${deviceId}] Статус клапана: ${status} (raw: ${res.data[0]})`);
				return status;
			},
			'чтение статуса клапана'
		);
	}

	async getErrors(deviceId: number): Promise<DeviceState['errors'] | null> {
		return this.executeWithRetry(
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
				return errors;
			},
			'чтение ошибок'
		);
	}

	async getProtectionState(deviceId: number): Promise<number | null> {
		return this.executeWithRetry(
			deviceId,
			async () => {
				this.logger.debug(`[${deviceId}] Чтение состояния защиты (1614)...`);
				const res: ModbusResponse = await this.client.readHoldingRegisters(1614, 1);
				this.logger.debug(`[${deviceId}] Состояние защиты: ${res.data[0]}`);
				return res.data[0];
			},
			'чтение состояния защиты'
		);
	}

	async checkDeviceAvailability(deviceId: number): Promise<boolean> {
		try {
			this.logger.log(`[${deviceId}] Проверка доступности устройства...`);

			const result = await this.executeWithRetry(
				deviceId,
				() => this.client.readHoldingRegisters(1601, 1),
				'проверка доступности'
			);

			if (result !== null) {
				this.logger.log(`[${deviceId}] Устройство доступно, получен ответ: ${result}`);
				return true;
			} else {
				this.logger.warn(`[${deviceId}] Устройство недоступно`);
				return false;
			}
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка проверки доступности: ${error}`);
			return false;
		}
	}

	/**
	 * Улучшенный опрос устройств с синхронизацией
	 */
	async pollDevices() {
		if (!this.isConnected) {
			await this.connect();
			if (!this.isConnected) {
				this.modbusGateway.broadcastError('Устройство недоступно');
				return;
			}
		}

		const updatedDevices: DeviceState[] = [];

		for (const deviceId of this.deviceIds) {
			this.logger.log(`=== Начало опроса устройства ${deviceId} ===`);

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
				// Читаем все параметры последовательно
				const mode = await this.getOperatingMode(deviceId);
				await this.timeout(this.REQUEST_DELAY);

				const temp = await this.getTemperatureSetpoint(deviceId);
				await this.timeout(this.REQUEST_DELAY);

				const speed = await this.getFanSpeed(deviceId);
				await this.timeout(this.REQUEST_DELAY);

				const airTemp = await this.getAirTemperature(deviceId);
				await this.timeout(this.REQUEST_DELAY);

				const waterTemp = await this.getWaterTemperature(deviceId);
				await this.timeout(this.REQUEST_DELAY);

				const pumpStatus = await this.getPumpStatus(deviceId);
				await this.timeout(this.REQUEST_DELAY);

				const valveStatus = await this.getValveStatus(deviceId);
				await this.timeout(this.REQUEST_DELAY);

				const errors = await this.getErrors(deviceId);
				await this.timeout(this.REQUEST_DELAY);

				const protection = await this.getProtectionState(deviceId);
				await this.timeout(this.REQUEST_DELAY);

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
			await this.timeout(500);
		}

		this.modbusGateway.broadcastDevicesState(updatedDevices);
	}

	// Методы записи с подтверждением
	async setOperatingMode(deviceId: number, mode: number): Promise<boolean> {
		try {
			this.logger.log(`[${deviceId}] Установка режима работы: ${mode}`);

			const writeResult = await this.executeWithRetry(
				deviceId,
				() => this.client.writeRegister(1601, mode),
				`запись режима работы ${mode}`
			);

			if (!writeResult) {
				this.logger.error(`[${deviceId}] Не удалось записать режим работы`);
				return false;
			}

			// Подтверждаем запись
			await this.timeout(200);
			const readResult = await this.getOperatingMode(deviceId);

			if (readResult === mode) {
				this.logger.log(`[${deviceId}] Режим работы успешно установлен: ${mode}`);
				return true;
			} else {
				this.logger.error(`[${deviceId}] Ошибка подтверждения записи режима: ожидалось ${mode}, получено ${readResult}`);
				return false;
			}
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка установки режима работы: ${error}`);
			return false;
		}
	}

	async setTemperatureSetpoint(deviceId: number, temperature: number): Promise<boolean> {
		try {
			this.logger.log(`[${deviceId}] Установка уставки температуры: ${temperature}°C`);

			if (temperature < 16 || temperature > 30) {
				this.logger.error(`[${deviceId}] Уставка температуры вне диапазона: ${temperature}°C`);
				return false;
			}

			const writeResult = await this.executeWithRetry(
				deviceId,
				() => this.client.writeRegister(1602, temperature),
				`запись уставки температуры ${temperature}`
			);

			if (!writeResult) {
				this.logger.error(`[${deviceId}] Не удалось записать уставку температуры`);
				return false;
			}

			// Подтверждаем запись
			await this.timeout(200);
			const readResult = await this.getTemperatureSetpoint(deviceId);

			if (readResult === temperature) {
				this.logger.log(`[${deviceId}] Уставка температуры успешно установлена: ${temperature}°C`);
				return true;
			} else {
				this.logger.error(`[${deviceId}] Ошибка подтверждения записи уставки: ожидалось ${temperature}, получено ${readResult}`);
				return false;
			}
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка установки уставки температуры: ${error}`);
			return false;
		}
	}

	async setFanSpeed(deviceId: number, speed: number): Promise<boolean> {
		try {
			this.logger.log(`[${deviceId}] Установка скорости вентилятора: ${speed}`);

			if (speed < 0 || speed > 4) {
				this.logger.error(`[${deviceId}] Скорость вентилятора вне диапазона: ${speed}`);
				return false;
			}

			const writeResult = await this.executeWithRetry(
				deviceId,
				() => this.client.writeRegister(1603, speed),
				`запись скорости вентилятора ${speed}`
			);

			if (!writeResult) {
				this.logger.error(`[${deviceId}] Не удалось записать скорость вентилятора`);
				return false;
			}

			// Подтверждаем запись
			await this.timeout(200);
			const readResult = await this.getFanSpeed(deviceId);

			if (readResult === speed) {
				this.logger.log(`[${deviceId}] Скорость вентилятора успешно установлена: ${speed}`);
				return true;
			} else {
				this.logger.error(`[${deviceId}] Ошибка подтверждения записи скорости: ожидалось ${speed}, получено ${readResult}`);
				return false;
			}
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка установки скорости вентилятора: ${error}`);
			return false;
		}
	}

	async setPowerState(deviceId: number, isOn: boolean): Promise<boolean> {
		try {
			const mode = isOn ? 2 : 0;
			this.logger.log(`[${deviceId}] Управление питанием: ${isOn ? 'включить' : 'выключить'} (режим: ${mode})`);
			return await this.setOperatingMode(deviceId, mode);
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка управления питанием: ${error}`);
			return false;
		}
	}

	getCurrentDevicesState(): DeviceState[] {
		return Array.from(this.devicesState.values());
	}

	getMasterStats() {
		const successRate = this.masterStats.totalRequests > 0
			? (this.masterStats.successfulRequests / this.masterStats.totalRequests * 100).toFixed(2)
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
			},
			performance: {
				successRate: this.masterStats.successfulRequests / Math.max(this.masterStats.totalRequests, 1) * 100,
			},
			errors: {
				totalErrors: this.masterStats.failedRequests,
				deviceConflicts: this.masterStats.deviceConflicts,
				timeoutErrors: this.masterStats.timeoutErrors,
			},
		};
	}

	resetStats() {
		this.masterStats = {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			deviceConflicts: 0,
			timeoutErrors: 0,
		};
		this.requestQueue = [];
		this.currentDeviceId = null;
		this.requestLock = false;
		this.logger.log('📊 Статистика и очередь сброшены');
	}
} 
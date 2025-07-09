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
export class ModbusService {
	private client: ModbusRTU;
	private readonly logger = new Logger(ModbusService.name);
	private isConnected = false;
	private readonly deviceIds = [5, 6, 7];
	private devicesState: Map<number, DeviceState>;
	private isPolling = false; // Флаг для предотвращения одновременного опроса

	constructor(
		@Inject(forwardRef(() => ModbusGateway))
		private readonly modbusGateway: ModbusGateway,
	) {
		this.client = new ModbusRTU();
		this.devicesState = new Map();
		this.initializeDevices();
		this.connect();
	}

	private initializeDevices() {
		this.deviceIds.forEach((deviceId) => {
			this.devicesState.set(deviceId, this.getInitialState(deviceId));
		});
	}

	private getInitialState(deviceId: number): DeviceState {
		return {
			id: `AC_${deviceId}`,
			name: `Кондиционер ${deviceId}`,
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
			await this.client.connectTCP('192.168.1.162', { port: 502 });
			this.isConnected = true;
			this.logger.log('Successfully connected to Modbus device');
		} catch (error) {
			const modbusError = error as ModbusError;
			this.logger.error(`Failed to connect: ${modbusError.message}`);
			this.isConnected = false;
		}
	}

	/**
	 * Проверка доступности устройства
	 */
	async checkDeviceAvailability(deviceId: number): Promise<boolean> {
		try {
			this.logger.log(`[${deviceId}] Проверка доступности устройства...`);
			this.client.setID(deviceId);

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

	@Interval(5000)
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

	// --- Методы чтения с подробной диагностикой ---
	async getOperatingMode(deviceId: number): Promise<number | null> {
		try {
			this.logger.debug(`[${deviceId}] Чтение режима работы (1601)...`);
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1601, 1);
			this.logger.debug(`[${deviceId}] Режим работы: ${res.data[0]}`);
			return res.data[0];
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка чтения режима работы: ${error}`);
			return null;
		}
	}

	async getTemperatureSetpoint(deviceId: number): Promise<number | null> {
		try {
			this.logger.debug(`[${deviceId}] Чтение уставки температуры (1602)...`);
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1602, 1);
			this.logger.debug(`[${deviceId}] Уставка температуры: ${res.data[0]}`);
			return res.data[0];
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка чтения уставки температуры: ${error}`);
			return null;
		}
	}

	async getFanSpeed(deviceId: number): Promise<number | null> {
		try {
			this.logger.debug(`[${deviceId}] Чтение скорости вентилятора (1603)...`);
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1603, 1);
			this.logger.debug(`[${deviceId}] Скорость вентилятора: ${res.data[0]}`);
			return res.data[0];
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка чтения скорости вентилятора: ${error}`);
			return null;
		}
	}

	async getAirTemperature(deviceId: number): Promise<number | null> {
		try {
			this.logger.debug(`[${deviceId}] Чтение температуры воздуха (1606)...`);
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1606, 1);
			const temp = res.data[0] * 0.5 - 20;
			this.logger.debug(`[${deviceId}] Температура воздуха: ${temp}°C (raw: ${res.data[0]})`);
			return temp;
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка чтения температуры воздуха: ${error}`);
			return null;
		}
	}

	async getWaterTemperature(deviceId: number): Promise<number | null> {
		try {
			this.logger.debug(`[${deviceId}] Чтение температуры воды (1607)...`);
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1607, 1);
			const temp = res.data[0] * 0.5 - 20;
			this.logger.debug(`[${deviceId}] Температура воды: ${temp}°C (raw: ${res.data[0]})`);
			return temp;
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка чтения температуры воды: ${error}`);
			return null;
		}
	}

	async getPumpStatus(deviceId: number): Promise<boolean | null> {
		try {
			this.logger.debug(`[${deviceId}] Чтение статуса помпы (1613)...`);
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1613, 1);
			const status = (res.data[0] & 0x01) !== 0;
			this.logger.debug(`[${deviceId}] Статус помпы: ${status} (raw: ${res.data[0]})`);
			return status;
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка чтения статуса помпы: ${error}`);
			return null;
		}
	}

	async getValveStatus(deviceId: number): Promise<boolean | null> {
		try {
			this.logger.debug(`[${deviceId}] Чтение статуса клапана (1619)...`);
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1619, 1);
			const status = (res.data[0] & (1 << 9)) !== 0;
			this.logger.debug(`[${deviceId}] Статус клапана: ${status} (raw: ${res.data[0]})`);
			return status;
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка чтения статуса клапана: ${error}`);
			return null;
		}
	}

	async getErrors(deviceId: number): Promise<DeviceState['errors'] | null> {
		try {
			this.logger.debug(`[${deviceId}] Чтение ошибок (1614)...`);
			this.client.setID(deviceId);
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
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка чтения ошибок: ${error}`);
			return null;
		}
	}

	async getProtectionState(deviceId: number): Promise<number | null> {
		try {
			this.logger.debug(`[${deviceId}] Чтение состояния защиты (1614)...`);
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1614, 1);
			this.logger.debug(`[${deviceId}] Состояние защиты: ${res.data[0]}`);
			return res.data[0];
		} catch (error) {
			this.logger.error(`[${deviceId}] Ошибка чтения состояния защиты: ${error}`);
			return null;
		}
	}

	getCurrentDevicesState(): DeviceState[] {
		return Array.from(this.devicesState.values());
	}

	// --- Методы записи с валидацией ---

	/**
	 * Установка режима работы (1601)
	 * Разрешены только значения: 0 (выключен) и 2 (охлаждение)
	 */
	async setOperatingMode(deviceId: number, mode: number): Promise<boolean> {
		// Валидация: только 0 (выключен) и 2 (охлаждение)
		if (mode !== 0 && mode !== 2) {
			this.logger.error(
				`Недопустимый режим работы: ${mode}. Разрешены только 0 (выключен) и 2 (охлаждение)`,
			);
			return false;
		}

		try {
			this.client.setID(deviceId);
			await this.client.writeRegister(1601, mode);
			this.logger.log(`Устройство ${deviceId}: установлен режим работы ${mode}`);
			return true;
		} catch (error) {
			this.logger.error(`Ошибка установки режима работы для устройства ${deviceId}: ${error}`);
			return false;
		}
	}

	/**
	 * Установка уставки температуры (1602)
	 * Разрешены значения от 16 до 30 градусов
	 */
	async setTemperatureSetpoint(deviceId: number, temperature: number): Promise<boolean> {
		// Валидация: температура от 16 до 30 градусов
		if (temperature < 16 || temperature > 30) {
			this.logger.error(
				`Недопустимая уставка температуры: ${temperature}. Разрешены значения от 16 до 30 градусов`,
			);
			return false;
		}

		try {
			this.client.setID(deviceId);
			await this.client.writeRegister(1602, temperature);
			this.logger.log(`Устройство ${deviceId}: установлена уставка температуры ${temperature}°C`);
			return true;
		} catch (error) {
			this.logger.error(
				`Ошибка установки уставки температуры для устройства ${deviceId}: ${error}`,
			);
			return false;
		}
	}

	/**
	 * Установка скорости вентилятора (1603)
	 * Разрешены только значения: 02 (Низкая), 03 (Средняя), 04 (Высокая), 05 (Авто)
	 */
	async setFanSpeed(deviceId: number, speed: number): Promise<boolean> {
		// Валидация: только 02, 03, 04, 05
		const allowedSpeeds = [2, 3, 4, 5];
		if (!allowedSpeeds.includes(speed)) {
			this.logger.error(
				`Недопустимая скорость вентилятора: ${speed}. Разрешены только: 02 (Низкая), 03 (Средняя), 04 (Высокая), 05 (Авто)`,
			);
			return false;
		}

		try {
			this.client.setID(deviceId);
			await this.client.writeRegister(1603, speed);
			this.logger.log(`Устройство ${deviceId}: установлена скорость вентилятора ${speed}`);
			return true;
		} catch (error) {
			this.logger.error(
				`Ошибка установки скорости вентилятора для устройства ${deviceId}: ${error}`,
			);
			return false;
		}
	}

	/**
	 * Включение/выключение кондиционера
	 * При включении устанавливает режим 2 (охлаждение), при выключении - 0
	 */
	async setPowerState(deviceId: number, isOn: boolean): Promise<boolean> {
		const mode = isOn ? 2 : 0;
		return this.setOperatingMode(deviceId, mode);
	}
}

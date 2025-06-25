import { Injectable, Logger } from '@nestjs/common';
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

	constructor(private readonly modbusGateway: ModbusGateway) {
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

	@Interval(5000)
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
			try {
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
				updatedDevices.push(updatedState);

				this.logger.log(
					`Устройство ${deviceId}: режим=${mode}, уставка=${temp}, скорость=${speed}, ` +
						`темп.воздуха=${airTemp}, темп.воды=${waterTemp}, помпа=${pumpStatus}, клапан=${valveStatus}, ` +
						`ошибки=${JSON.stringify(errors)}, защита=${protection}`,
				);
			} catch (error) {
				this.logger.error(`Ошибка при опросе устройства ${deviceId}`);
				const offlineState = {
					...this.devicesState.get(deviceId)!,
					isOnline: false,
				};
				this.devicesState.set(deviceId, offlineState);
				updatedDevices.push(offlineState);
			}
			await new Promise((res) => setTimeout(res, 100)); // задержка между опросами
		}

		this.modbusGateway.broadcastDevicesState(updatedDevices);
	}

	// --- Методы чтения (аналогично предыдущей версии, с deviceId) ---
	async getOperatingMode(deviceId: number): Promise<number | null> {
		try {
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1601, 1);
			return res.data[0];
		} catch {
			return null;
		}
	}
	async getTemperatureSetpoint(deviceId: number): Promise<number | null> {
		try {
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1602, 1);
			return res.data[0];
		} catch {
			return null;
		}
	}
	async getFanSpeed(deviceId: number): Promise<number | null> {
		try {
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1603, 1);
			return res.data[0];
		} catch {
			return null;
		}
	}
	async getAirTemperature(deviceId: number): Promise<number | null> {
		try {
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1606, 1);
			return res.data[0] * 0.5 - 20;
		} catch {
			return null;
		}
	}
	async getWaterTemperature(deviceId: number): Promise<number | null> {
		try {
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1607, 1);
			return res.data[0] * 0.5 - 20;
		} catch {
			return null;
		}
	}
	async getPumpStatus(deviceId: number): Promise<boolean | null> {
		try {
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1613, 1);
			return (res.data[0] & 0x01) !== 0;
		} catch {
			return null;
		}
	}
	async getValveStatus(deviceId: number): Promise<boolean | null> {
		try {
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1619, 1);
			return (res.data[0] & (1 << 9)) !== 0;
		} catch {
			return null;
		}
	}
	async getErrors(deviceId: number): Promise<DeviceState['errors'] | null> {
		try {
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1614, 1);
			return {
				tempSensorError: (res.data[0] & (1 << 2)) !== 0,
				waterTempSensor1Error: (res.data[0] & (1 << 3)) !== 0,
				waterTempSensor2Error: (res.data[0] & (1 << 4)) !== 0,
				fanSpeedError: (res.data[0] & (1 << 8)) !== 0,
				pumpError: (res.data[0] & (1 << 14)) !== 0,
			};
		} catch {
			return null;
		}
	}
	async getProtectionState(deviceId: number): Promise<number | null> {
		try {
			this.client.setID(deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1614, 1);
			return res.data[0];
		} catch {
			return null;
		}
	}

	getCurrentDevicesState(): DeviceState[] {
		return Array.from(this.devicesState.values());
	}
}

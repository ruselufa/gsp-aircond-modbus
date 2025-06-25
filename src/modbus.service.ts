import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import ModbusRTU from 'modbus-serial';

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
	private readonly deviceId = 5;

	constructor() {
		this.client = new ModbusRTU();
		this.connect();
	}

	private async connect() {
		try {
			await this.client.connectTCP('192.168.1.162', { port: 502 });
			this.client.setID(this.deviceId);
			this.isConnected = true;
			this.logger.log('Successfully connected to Modbus device');
		} catch (error) {
			const modbusError = error as ModbusError;
			this.logger.error(`Failed to connect: ${modbusError.message}`);
			this.isConnected = false;
		}
	}

	// --- Автоматический опрос ---
	@Interval(5000)
	async pollDevice() {
		if (!this.isConnected) {
			await this.connect();
			if (!this.isConnected) return;
		}
		try {
			const mode = await this.getOperatingMode();
			const temp = await this.getTemperatureSetpoint();
			const speed = await this.getFanSpeed();

			const airTemp = await this.getAirTemperature();
			const waterTemp = await this.getWaterTemperature();
			const pumpStatus = await this.getPumpStatus();
			const valveStatus = await this.getValveStatus();
			const errors = await this.getErrors();
			const protection = await this.getProtectionState();

			this.logger.log(
				`Опрос Modbus: режим=${mode}, уставка=${temp}, скорость=${speed}, ` +
					`темп.воздуха=${airTemp}, темп.воды=${waterTemp}, помпа=${pumpStatus}, клапан=${valveStatus}, ` +
					`ошибки=${JSON.stringify(errors)}, защита=${protection}`,
			);
		} catch (error) {
			this.logger.error('Ошибка при опросе устройства');
		}
	}

	// --- Чтение ---
	async getOperatingMode(): Promise<number | null> {
		try {
			this.client.setID(this.deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1601, 1);
			this.logger.log(`Режим работы: ${res.data[0]}`);
			return res.data[0];
		} catch (error) {
			this.logger.error('Failed to read operating mode');
			return null;
		}
	}

	async getTemperatureSetpoint(): Promise<number | null> {
		try {
			this.client.setID(this.deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1602, 1);
			this.logger.log(`Уставка температуры: ${res.data[0]}`);
			return res.data[0];
		} catch (error) {
			this.logger.error('Failed to read temperature setpoint');
			return null;
		}
	}

	async getFanSpeed(): Promise<number | null> {
		try {
			this.client.setID(this.deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1603, 1);
			this.logger.log(`Скорость вентилятора: ${res.data[0]}`);
			return res.data[0];
		} catch (error) {
			this.logger.error('Failed to read fan speed');
			return null;
		}
	}

	async getAirTemperature(): Promise<number | null> {
		try {
			this.client.setID(this.deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1606, 1);
			return res.data[0] * 0.5 - 20;
		} catch (error) {
			this.logger.error('Failed to read air temperature');
			return null;
		}
	}

	async getWaterTemperature(): Promise<number | null> {
		try {
			this.client.setID(this.deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1607, 1);
			return res.data[0] * 0.5 - 20;
		} catch (error) {
			this.logger.error('Failed to read water temperature');
			return null;
		}
	}

	async getPumpStatus(): Promise<boolean | null> {
		try {
			this.client.setID(this.deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1613, 1);
			return (res.data[0] & 0x01) !== 0;
		} catch (error) {
			this.logger.error('Failed to read pump status');
			return null;
		}
	}

	async getValveStatus(): Promise<boolean | null> {
		try {
			this.client.setID(this.deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1619, 1);
			return (res.data[0] & (1 << 9)) !== 0;
		} catch (error) {
			this.logger.error('Failed to read valve status');
			return null;
		}
	}

	async getErrors(): Promise<any> {
		try {
			this.client.setID(this.deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1614, 1);
			return {
				tempSensorError: (res.data[0] & (1 << 2)) !== 0,
				waterTempSensor1Error: (res.data[0] & (1 << 3)) !== 0,
				waterTempSensor2Error: (res.data[0] & (1 << 4)) !== 0,
				fanSpeedError: (res.data[0] & (1 << 8)) !== 0,
				pumpError: (res.data[0] & (1 << 14)) !== 0,
			};
		} catch (error) {
			this.logger.error('Failed to read errors');
			return null;
		}
	}

	async getProtectionState(): Promise<number | null> {
		try {
			this.client.setID(this.deviceId);
			const res: ModbusResponse = await this.client.readHoldingRegisters(1614, 1);
			return res.data[0];
		} catch (error) {
			this.logger.error('Failed to read protection state');
			return null;
		}
	}

	// --- Запись ---
	async setOperatingMode(mode: number): Promise<boolean> {
		try {
			this.client.setID(this.deviceId);
			await this.client.writeRegister(1601, mode);
			return true;
		} catch (error) {
			this.logger.error('Failed to set operating mode');
			return false;
		}
	}

	async setTemperatureSetpoint(temp: number): Promise<boolean> {
		try {
			this.client.setID(this.deviceId);
			await this.client.writeRegister(1602, temp);
			return true;
		} catch (error) {
			this.logger.error('Failed to set temperature setpoint');
			return false;
		}
	}

	async setFanSpeed(speed: number): Promise<boolean> {
		try {
			this.client.setID(this.deviceId);
			await this.client.writeRegister(1603, speed);
			return true;
		} catch (error) {
			this.logger.error('Failed to set fan speed');
			return false;
		}
	}
}

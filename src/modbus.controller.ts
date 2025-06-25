import { Controller, Get, Post, Body } from '@nestjs/common';
import { ModbusService } from './modbus.service';

@Controller('modbus')
export class ModbusController {
	constructor(private readonly modbusService: ModbusService) {}

	// --- Чтение ---
	@Get('operating-mode')
	async getOperatingMode() {
		return { mode: await this.modbusService.getOperatingMode() };
	}

	@Get('temperature-setpoint')
	async getTemperatureSetpoint() {
		return { temperature: await this.modbusService.getTemperatureSetpoint() };
	}

	@Get('fan-speed')
	async getFanSpeed() {
		return { speed: await this.modbusService.getFanSpeed() };
	}

	// --- Запись ---
	@Post('operating-mode')
	async setOperatingMode(@Body('mode') mode: number) {
		return { success: await this.modbusService.setOperatingMode(mode) };
	}

	@Post('temperature-setpoint')
	async setTemperatureSetpoint(@Body('temperature') temperature: number) {
		return { success: await this.modbusService.setTemperatureSetpoint(temperature) };
	}

	@Post('fan-speed')
	async setFanSpeed(@Body('speed') speed: number) {
		return { success: await this.modbusService.setFanSpeed(speed) };
	}
}

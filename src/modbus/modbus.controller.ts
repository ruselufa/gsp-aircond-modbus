import { Controller, Get, Param, Post, Body } from '@nestjs/common';
import { ModbusService } from './modbus.service';
import { DeviceState } from './device.types';

@Controller('modbus')
export class ModbusController {
	constructor(private readonly modbusService: ModbusService) { }

	@Get('state')
	getDevicesState(): DeviceState[] {
		return this.modbusService.getCurrentDevicesState();
	}

	@Get('state/:deviceId')
	getDeviceState(@Param('deviceId') deviceId: string): DeviceState | null {
		const id = parseInt(deviceId);
		return this.modbusService.getCurrentDevicesState().find((d) => d.id === `AC_${id}`) || null;
	}

	/**
	 * Принудительное обновление состояния конкретного устройства
	 * Полезно для получения актуального состояния без ожидания следующего цикла опроса
	 */
	@Post('refresh/:deviceId')
	async refreshDeviceState(@Param('deviceId') deviceId: string): Promise<{ success: boolean; device?: DeviceState }> {
		const id = parseInt(deviceId);
		const updatedDevice = await this.modbusService.updateDeviceStateImmediately(id);

		if (updatedDevice) {
			return { success: true, device: updatedDevice };
		} else {
			return { success: false };
		}
	}

	/**
	 * Принудительное обновление состояния всех устройств
	 */
	@Post('refresh-all')
	async refreshAllDevicesState(): Promise<{ success: boolean; devices: DeviceState[] }> {
		const deviceIds = [5, 6, 7]; // те же ID, что и в сервисе
		const updatedDevices: DeviceState[] = [];

		for (const deviceId of deviceIds) {
			const updatedDevice = await this.modbusService.updateDeviceStateImmediately(deviceId);
			if (updatedDevice) {
				updatedDevices.push(updatedDevice);
			}
		}

		return {
			success: updatedDevices.length > 0,
			devices: updatedDevices
		};
	}

	/**
	 * Принудительный запуск опроса всех устройств с отправкой данных через WebSocket
	 */
	@Post('poll-all')
	async pollAllDevices(): Promise<{ success: boolean; message: string }> {
		try {
			await this.modbusService.pollDevices();
			return {
				success: true,
				message: 'Опрос всех устройств выполнен, данные отправлены через WebSocket'
			};
		} catch (error) {
			return {
				success: false,
				message: `Ошибка при опросе устройств: ${error}`
			};
		}
	}

	/**
	 * Получение статистики работы Modbus Master
	 */
	@Get('master/stats')
	getMasterStats() {
		return this.modbusService.getMasterStats();
	}

	/**
	 * Получение расширенной диагностики сети
	 */
	@Get('master/diagnostics')
	getNetworkDiagnostics(): any {
		return this.modbusService.getNetworkDiagnostics();
	}

	/**
	 * Сброс статистики и очистка очереди
	 */
	@Post('master/reset-stats')
	resetStats() {
		this.modbusService.resetStats();
		return { success: true, message: 'Статистика сброшена' };
	}

	/**
	 * Проверка доступности конкретного устройства
	 */
	@Get('master/availability/:deviceId')
	async checkDeviceAvailability(@Param('deviceId') deviceId: string): Promise<{ success: boolean; available: boolean }> {
		const id = parseInt(deviceId);
		try {
			const available = await this.modbusService.checkDeviceAvailability(id);
			return { success: true, available };
		} catch (error) {
			return { success: false, available: false };
		}
	}

	/**
	 * Пакетное чтение регистров для конкретного устройства
	 */
	@Post('master/read-batch/:deviceId')
	async readRegistersBatch(
		@Param('deviceId') deviceId: string,
		@Body() body: { registers: number[] }
	): Promise<{ success: boolean; data?: Record<string, number> }> {
		const id = parseInt(deviceId);
		const registers = body.registers;

		if (!registers || !Array.isArray(registers)) {
			return { success: false };
		}

		try {
			const results = await this.modbusService.readRegistersBatch(id, registers);
			const data: Record<string, number> = {};

			results.forEach((value, register) => {
				data[`register_${register}`] = value;
			});

			return { success: true, data };
		} catch (error) {
			return { success: false };
		}
	}

	/**
	 * Приоритетное чтение регистра
	 */
	@Post('master/read-priority/:deviceId')
	async readRegisterWithPriority(
		@Param('deviceId') deviceId: string,
		@Body() body: { register: number; priority?: 'high' | 'normal' | 'low' }
	): Promise<{ success: boolean; value?: number }> {
		const id = parseInt(deviceId);
		const { register, priority = 'normal' } = body;

		if (!register) {
			return { success: false };
		}

		try {
			const value = await this.modbusService.readRegisterWithPriority(id, register, priority);
			return { success: value !== null, value: value || 0 };
		} catch (error) {
			return { success: false };
		}
	}

	/**
	 * Приоритетная запись регистра
	 */
	@Post('master/write-priority/:deviceId')
	async writeRegisterWithPriority(
		@Param('deviceId') deviceId: string,
		@Body() body: { register: number; value: number; priority?: 'high' | 'normal' | 'low' }
	): Promise<{ success: boolean }> {
		const id = parseInt(deviceId);
		const { register, value, priority = 'normal' } = body;

		if (!register || value === undefined) {
			return { success: false };
		}

		try {
			const success = await this.modbusService.writeRegisterWithPriority(id, register, value, priority);
			return { success };
		} catch (error) {
			return { success: false };
		}
	}

	/**
	 * Управление режимом работы кондиционера
	 */
	@Post('control/mode/:deviceId')
	async setOperatingMode(
		@Param('deviceId') deviceId: string,
		@Body() body: { mode: number }
	): Promise<{ success: boolean; message?: string }> {
		const id = parseInt(deviceId);
		const { mode } = body;

		if (mode === undefined || mode < 0 || mode > 4) {
			return { success: false, message: 'Неверный режим работы (0-4)' };
		}

		try {
			const success = await this.modbusService.setOperatingMode(id, mode);
			return {
				success,
				message: success ? 'Режим работы установлен' : 'Ошибка установки режима'
			};
		} catch (error) {
			return { success: false, message: 'Ошибка сервера' };
		}
	}

	/**
	 * Управление уставкой температуры
	 */
	@Post('control/temperature/:deviceId')
	async setTemperature(
		@Param('deviceId') deviceId: string,
		@Body() body: { temperature: number }
	): Promise<{ success: boolean; message?: string }> {
		const id = parseInt(deviceId);
		const { temperature } = body;

		if (temperature === undefined || temperature < 16 || temperature > 30) {
			return { success: false, message: 'Температура должна быть в диапазоне 16-30°C' };
		}

		try {
			const success = await this.modbusService.setTemperatureSetpoint(id, temperature);
			return {
				success,
				message: success ? 'Уставка температуры установлена' : 'Ошибка установки температуры'
			};
		} catch (error) {
			return { success: false, message: 'Ошибка сервера' };
		}
	}

	/**
	 * Управление скоростью вентилятора
	 */
	@Post('control/fan-speed/:deviceId')
	async setFanSpeed(
		@Param('deviceId') deviceId: string,
		@Body() body: { speed: number }
	): Promise<{ success: boolean; message?: string }> {
		const id = parseInt(deviceId);
		const { speed } = body;

		if (speed === undefined || speed < 0 || speed > 4) {
			return { success: false, message: 'Скорость должна быть в диапазоне 0-4' };
		}

		try {
			const success = await this.modbusService.setFanSpeed(id, speed);
			return {
				success,
				message: success ? 'Скорость вентилятора установлена' : 'Ошибка установки скорости'
			};
		} catch (error) {
			return { success: false, message: 'Ошибка сервера' };
		}
	}

	/**
	 * Управление питанием (включение/выключение)
	 */
	@Post('control/power/:deviceId')
	async setPowerState(
		@Param('deviceId') deviceId: string,
		@Body() body: { isOn: boolean }
	): Promise<{ success: boolean; message?: string }> {
		const id = parseInt(deviceId);
		const { isOn } = body;

		if (isOn === undefined) {
			return { success: false, message: 'Не указано состояние питания' };
		}

		try {
			const success = await this.modbusService.setPowerState(id, isOn);
			return {
				success,
				message: success ? `Кондиционер ${isOn ? 'включен' : 'выключен'}` : 'Ошибка управления питанием'
			};
		} catch (error) {
			return { success: false, message: 'Ошибка сервера' };
		}
	}

	/**
	 * Получение состояния здоровья системы
	 */
	@Get('health')
	getSystemHealth(): { status: string; details: any } {
		const stats = this.modbusService.getMasterStats();
		const diagnostics = this.modbusService.getNetworkDiagnostics();

		const successRate = parseFloat(stats.successRate);
		const isHealthy = successRate > 80 && diagnostics.connection.isConnected;

		return {
			status: isHealthy ? 'healthy' : 'degraded',
			details: {
				successRate: stats.successRate,
				isConnected: diagnostics.connection.isConnected,
				deviceConflicts: diagnostics.errors.deviceConflicts,
				timeoutErrors: diagnostics.errors.timeoutErrors,
				queueLength: diagnostics.queue.length,
			}
		};
	}
}

import { Controller, Get, Param } from '@nestjs/common';
import { ModbusService } from './modbus.service';
import { DeviceState } from './device.types';

@Controller('modbus')
export class ModbusController {
	constructor(private readonly modbusService: ModbusService) {}

	@Get('state')
	getDevicesState(): DeviceState[] {
		return this.modbusService.getCurrentDevicesState();
	}

	@Get('state/:deviceId')
	getDeviceState(@Param('deviceId') deviceId: string): DeviceState | null {
		const id = parseInt(deviceId);
		return this.modbusService.getCurrentDevicesState().find((d) => d.id === `AC_${id}`) || null;
	}
}

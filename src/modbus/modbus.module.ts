import { Module } from '@nestjs/common';
import { ModbusService } from './modbus.service';
import { ModbusController } from './modbus.controller';
import { ModbusGateway } from './modbus.gateway';

@Module({
	controllers: [ModbusController],
	providers: [ModbusService, ModbusGateway],
	exports: [ModbusService, ModbusGateway],
})
export class ModbusModule {}

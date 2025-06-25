import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ModbusService } from './modbus/modbus.service';
import { ModbusController } from './modbus/modbus.controller';
import { ModbusGateway } from './modbus/modbus.gateway';

@Module({
	imports: [ScheduleModule.forRoot()],
	controllers: [ModbusController],
	providers: [ModbusService, ModbusGateway],
})
export class AppModule {}

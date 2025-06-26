import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ModbusModule } from './modbus/modbus.module';

@Module({
	imports: [ScheduleModule.forRoot(), ModbusModule],
})
export class AppModule {}

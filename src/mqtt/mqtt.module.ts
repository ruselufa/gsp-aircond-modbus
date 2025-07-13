import { Module } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import { AircondMqttService } from './aircond-mqtt.service';

@Module({
	providers: [MqttService, AircondMqttService],
	exports: [MqttService, AircondMqttService],
})
export class MqttModule {}

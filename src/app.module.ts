import { Module } from '@nestjs/common';
import { MqttModule } from './mqtt/mqtt.module';
import { AircondGateway } from './mqtt/aircond.gateway';

@Module({
	imports: [MqttModule],
	controllers: [],
	providers: [AircondGateway],
})
export class AppModule {}

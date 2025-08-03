import { Module } from '@nestjs/common';
import { MqttModule } from './mqtt/mqtt.module';
import { AircondGateway } from './mqtt/aircond.gateway';
import { MqttController } from './mqtt.controller';

@Module({
	imports: [MqttModule],
	controllers: [MqttController],
	providers: [AircondGateway],
})
export class AppModule {}

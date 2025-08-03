#!/usr/bin/env node

const io = require('socket.io-client');

// Конфигурация
const SERVER_URL = 'http://localhost:3001';
const TEST_DURATION = 30000; // 30 секунд
const UPDATE_INTERVAL = 1000; // 1 секунда

console.log('🚀 Запуск теста производительности MQTT модуля...');
console.log(`📡 Подключение к серверу: ${SERVER_URL}`);

const socket = io(SERVER_URL, {
	transports: ['websocket'],
	timeout: 5000,
});

let messageCount = 0;
let lastMessageTime = Date.now();
let connectionStartTime = Date.now();

socket.on('connect', () => {
	console.log('✅ Подключение установлено');
	connectionStartTime = Date.now();
	
	// Подписываемся на обновления
	socket.emit('subscribe');
	
	// Запускаем тест
	setTimeout(() => {
		console.log('⏰ Тест завершен');
		printResults();
		socket.disconnect();
		process.exit(0);
	}, TEST_DURATION);
});

socket.on('disconnect', () => {
	console.log('❌ Соединение разорвано');
});

socket.on('connect_error', (error) => {
	console.error('❌ Ошибка подключения:', error.message);
});

socket.on('devicesState', (data) => {
	messageCount++;
	const now = Date.now();
	const timeSinceLastMessage = now - lastMessageTime;
	lastMessageTime = now;
	
	console.log(`📊 Получено обновление #${messageCount}:`);
	console.log(`   ⏱️  Время с последнего сообщения: ${timeSinceLastMessage}ms`);
	console.log(`   📱 Устройств: ${data.devices?.length || 0}`);
	console.log(`   👥 Клиентов: ${data.clientCount || 0}`);
	
	if (data.devices && data.devices.length > 0) {
		data.devices.forEach(device => {
			console.log(`   🔧 ${device.id}: temp=${device.temperature}°C, power=${device.isOn ? 'ON' : 'OFF'}`);
		});
	}
});

function printResults() {
	const testDuration = Date.now() - connectionStartTime;
	const messagesPerSecond = messageCount / (testDuration / 1000);
	
	console.log('\n📈 Результаты теста:');
	console.log(`   ⏱️  Длительность теста: ${testDuration}ms`);
	console.log(`   📨 Получено сообщений: ${messageCount}`);
	console.log(`   🚀 Сообщений в секунду: ${messagesPerSecond.toFixed(2)}`);
	console.log(`   📊 Средний интервал: ${testDuration / messageCount}ms`);
	
	if (messagesPerSecond > 2) {
		console.log('⚠️  Слишком много сообщений в секунду - возможны проблемы с throttling');
	} else if (messagesPerSecond < 0.1) {
		console.log('⚠️  Слишком мало сообщений - возможны проблемы с MQTT подключением');
	} else {
		console.log('✅ Производительность в норме');
	}
}

// Обработка завершения
process.on('SIGINT', () => {
	console.log('\n🛑 Тест прерван пользователем');
	printResults();
	socket.disconnect();
	process.exit(0);
});

console.log('⏳ Ожидание подключения...'); 
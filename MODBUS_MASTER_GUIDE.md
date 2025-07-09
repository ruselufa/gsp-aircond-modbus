# Modbus Master - Руководство пользователя

## Что такое Modbus Master?

Ваш ПК теперь действует как полноценный **Modbus Master** - устройство, которое управляет сетью Modbus устройств (slave). Это означает, что ваш компьютер:

- ✅ Инициирует все коммуникации в сети Modbus
- ✅ Управляет очередью запросов с приоритетами
- ✅ Обеспечивает надежную связь с устройствами
- ✅ Предоставляет статистику и мониторинг
- ✅ Поддерживает пакетные операции

## Архитектура Modbus Master

```
┌─────────────────┐    TCP/IP    ┌─────────────────┐
│   Ваш ПК        │ ──────────── │  Modbus Gateway │
│  (Master)       │              │   (192.168.1.162)│
└─────────────────┘              └─────────────────┘
         │                                │
         │                        ┌───────┴───────┐
         │                        │               │
    ┌────▼────┐              ┌────▼────┐    ┌────▼────┐
    │Device 5 │              │Device 6 │    │Device 7 │
    │(Slave)  │              │(Slave)  │    │(Slave)  │
    └─────────┘              └─────────┘    └─────────┘
```

## Новые возможности

### 1. **Очередь запросов с приоритетами**

```typescript
// Приоритеты запросов:
- 'high'   - Критические команды (включение/выключение)
- 'normal' - Обычные операции (чтение состояния)
- 'low'    - Фоновые задачи (логирование)
```

### 2. **Пакетное чтение регистров**

```typescript
// Вместо чтения по одному регистру:
await client.readHoldingRegisters(1601, 1); // режим
await client.readHoldingRegisters(1602, 1); // температура
await client.readHoldingRegisters(1603, 1); // скорость

// Теперь можно читать пакетами:
const registers = [1601, 1602, 1603, 1606, 1607];
const results = await readRegistersBatch(deviceId, registers);
```

### 3. **Статистика и мониторинг**

```typescript
// Получение статистики работы master'а:
{
  totalRequests: 1250,
  successfulRequests: 1180,
  failedRequests: 70,
  averageResponseTime: 245, // ms
  successRate: "94.40%",
  queueLength: 3,
  isProcessing: true
}
```

## API Endpoints

### Основные операции

#### 1. Получение состояния устройств
```http
GET /modbus/state
GET /modbus/state/:deviceId
```

#### 2. Принудительное обновление
```http
POST /modbus/refresh/:deviceId
POST /modbus/refresh-all
```

### Master операции

#### 3. Статистика Master'а
```http
GET /modbus/master/stats
```

**Ответ:**
```json
{
  "totalRequests": 1250,
  "successfulRequests": 1180,
  "failedRequests": 70,
  "averageResponseTime": 245,
  "lastRequestTime": 1703123456789,
  "connectionErrors": 2,
  "timeoutErrors": 5,
  "queueLength": 3,
  "isProcessing": true,
  "successRate": "94.40%"
}
```

#### 4. Пакетное чтение регистров
```http
POST /modbus/master/read-batch/:deviceId
Content-Type: application/json

{
  "registers": [1601, 1602, 1603, 1606, 1607]
}
```

**Ответ:**
```json
{
  "success": true,
  "data": {
    "register_1601": 2,
    "register_1602": 24,
    "register_1603": 3,
    "register_1606": 45,
    "register_1607": 12
  }
}
```

#### 5. Приоритетное чтение
```http
POST /modbus/master/read-priority/:deviceId
Content-Type: application/json

{
  "register": 1601,
  "priority": "high"
}
```

**Ответ:**
```json
{
  "success": true,
  "value": 2
}
```

#### 6. Приоритетная запись
```http
POST /modbus/master/write-priority/:deviceId
Content-Type: application/json

{
  "register": 1601,
  "value": 2,
  "priority": "high"
}
```

**Ответ:**
```json
{
  "success": true
}
```

## Примеры использования

### 1. Быстрое получение всех параметров устройства

```typescript
// Старый способ (медленно):
const mode = await getOperatingMode(deviceId);
const temp = await getTemperatureSetpoint(deviceId);
const speed = await getFanSpeed(deviceId);
// ... 5 отдельных запросов

// Новый способ (быстро):
const registers = [1601, 1602, 1603, 1606, 1607, 1613, 1619, 1614];
const results = await readRegistersBatch(deviceId, registers);
// 1 пакетный запрос вместо 8 отдельных
```

### 2. Критическая команда с высоким приоритетом

```typescript
// Выключение кондиционера - критическая операция
await writeRegisterWithPriority(deviceId, 1601, 0, 'high');
// Эта команда будет обработана первой в очереди
```

### 3. Мониторинг производительности

```typescript
// Проверка здоровья системы
const stats = await getMasterStats();
if (stats.successRate < '90%') {
  console.log('⚠️ Внимание: низкий процент успешных запросов');
}
if (stats.averageResponseTime > 1000) {
  console.log('⚠️ Внимание: медленные ответы от устройств');
}
```

## Преимущества Modbus Master

### 1. **Производительность**
- Пакетное чтение ускоряет опрос в 3-5 раз
- Очередь запросов предотвращает конфликты
- Приоритеты обеспечивают обработку критических команд

### 2. **Надежность**
- Автоматическое переподключение при разрыве связи
- Таймауты предотвращают "зависание"
- Статистика помогает диагностировать проблемы

### 3. **Мониторинг**
- Детальная статистика работы
- Отслеживание времени ответа
- Процент успешных операций

### 4. **Гибкость**
- Разные приоритеты для разных операций
- Возможность принудительного обновления
- Пакетные операции для оптимизации

## Рекомендации по использованию

### 1. **Приоритеты запросов**
```typescript
// Используйте 'high' для:
- Включение/выключение устройств
- Критические настройки
- Команды безопасности

// Используйте 'normal' для:
- Чтение состояния
- Изменение настроек
- Мониторинг

// Используйте 'low' для:
- Логирование
- Фоновые задачи
- Некритичные операции
```

### 2. **Пакетное чтение**
```typescript
// Группируйте связанные регистры:
const temperatureRegisters = [1602, 1606, 1607]; // уставка, воздух, вода
const statusRegisters = [1601, 1603, 1613, 1619]; // режим, скорость, помпа, клапан
```

### 3. **Мониторинг**
```typescript
// Регулярно проверяйте статистику:
setInterval(async () => {
  const stats = await getMasterStats();
  if (stats.successRate < '95%') {
    // Отправить уведомление администратору
  }
}, 60000); // каждую минуту
```

## Заключение

Теперь ваш ПК работает как профессиональный Modbus Master с возможностями:

- 🚀 **Высокая производительность** - пакетные операции и оптимизированная очередь
- 🛡️ **Надежность** - автоматическое восстановление и таймауты
- 📊 **Мониторинг** - детальная статистика и диагностика
- ⚡ **Гибкость** - приоритеты и принудительные операции

Это позволяет эффективно управлять сетью Modbus устройств с промышленным уровнем надежности и производительности. 
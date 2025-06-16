// server.js - Супер продвинутая версия с асинхронной генерацией
const express = require('express');
const { Midjourney } = require('midjourney');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const activeTasks = new Map(); // Хранилище активных задач

app.use(express.json());
app.use(express.static('public'));

// Директория для хранения данных
const DATA_DIR = path.join(__dirname, 'data');

// Инициализация директории данных
async function initDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating data directory:', error);
  }
}

// Файловая база данных
class FileDB {
  constructor(filename) {
    this.filepath = path.join(DATA_DIR, filename);
    this.data = new Map();
  }

  async load() {
    try {
      const content = await fs.readFile(this.filepath, 'utf8');
      const parsed = JSON.parse(content);
      this.data = new Map(parsed);
    } catch (error) {
      this.data = new Map();
    }
  }

  async save() {
    try {
      const content = JSON.stringify([...this.data]);
      await fs.writeFile(this.filepath, content, 'utf8');
    } catch (error) {
      console.error('Error saving to file:', error);
    }
  }

  get(key) { return this.data.get(key); }
  set(key, value) { this.data.set(key, value); this.save(); return this; }
  has(key) { return this.data.has(key); }
  delete(key) { const result = this.data.delete(key); this.save(); return result; }
  get size() { return this.data.size; }
  entries() { return this.data.entries(); }
  values() { return Array.from(this.data.values()); }
}

// Инициализация баз данных
const users = new FileDB('users.json');
const userUsage = new FileDB('usage.json');
const generationHistory = new FileDB('history.json');
const userSessions = new Map();

// Инициализация
async function init() {
  await initDataDir();
  await users.load();
  await userUsage.load();
  await generationHistory.load();
  console.log(`📊 Загружено ${users.size} пользователей из базы данных`);
}

// Функция генерации API ключей
function generateApiKey() {
  return 'mj_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Middleware для проверки API ключей
function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API ключ обязателен. Добавьте заголовок X-API-Key' });
  }
  
  const user = users.get(apiKey);
  if (!user) {
    return res.status(401).json({ error: 'Недействительный API ключ' });
  }
  
  // Проверяем статус пользователя
  if (user.status === 'blocked') {
    return res.status(403).json({ error: 'Ваш аккаунт заблокирован' });
  }
  
  // Для админов пропускаем проверку лимитов
  if (user.role === 'admin') {
    req.user = user;
    req.apiKey = apiKey;
    return next();
  }
  
  // Проверяем лимиты для обычных пользователей
  const currentUsage = userUsage.get(apiKey) || { count: 0, resetDate: new Date() };
  
  // Проверяем нужно ли сбросить счетчик (раз в месяц)
  const now = new Date();
  const resetDate = new Date(currentUsage.resetDate);
  if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
    currentUsage.count = 0;
    currentUsage.resetDate = now;
    userUsage.set(apiKey, currentUsage);
  }
  
  if (currentUsage.count >= user.monthlyLimit) {
    return res.status(429).json({ 
      error: 'Превышен месячный лимит генераций',
      limit: user.monthlyLimit,
      used: currentUsage.count,
      resetDate: currentUsage.resetDate
    });
  }
  
  req.user = user;
  req.apiKey = apiKey;
  next();
}

// Функция создания Midjourney клиента
async function getMidjourneyClient(user) {
  const client = new Midjourney({
    ServerId: user.serverId,
    ChannelId: user.channelId,
    SalaiToken: user.salaiToken,
    Debug: false,
    Ws: true
  });
  
  await client.init();
  return client;
}

// === API ENDPOINTS ===

// Проверка статуса системы
app.get('/health', (req, res) => {
  const totalUsers = users.size;
  const activeUsers = Array.from(users.entries()).filter(([_, user]) => user.status === 'active').length;
  const blockedUsers = Array.from(users.entries()).filter(([_, user]) => user.status === 'blocked').length;
  const adminUsers = Array.from(users.entries()).filter(([_, user]) => user.role === 'admin').length;
  
  res.json({
    status: 'ok',
    stats: {
      totalUsers,
      activeUsers,
      blockedUsers,
      adminUsers,
      activeSessions: userSessions.size,
      activeTasks: activeTasks.size  // Добавлено!
    },
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ADMIN: Создание нового пользователя
app.post('/admin/users', async (req, res) => {
  const { serverId, channelId, salaiToken, monthlyLimit = 100, userEmail, role = 'user' } = req.body;
  
  if (!serverId || !channelId || !salaiToken || !userEmail) {
    return res.status(400).json({
      error: 'Требуются: serverId, channelId, salaiToken, userEmail'
    });
  }
  
  const apiKey = generateApiKey();
  const user = {
    apiKey,
    serverId,
    channelId,
    salaiToken,
    monthlyLimit: role === 'admin' ? -1 : monthlyLimit,
    userEmail,
    role,
    createdAt: new Date().toISOString(),
    status: 'active'
  };
  
  users.set(apiKey, user);
  userUsage.set(apiKey, { count: 0, resetDate: new Date() });
  
  console.log(`👤 Новый ${role} создан: ${userEmail}`);
  
  res.json({
    success: true,
    apiKey: apiKey,
    user: {
      email: userEmail,
      monthlyLimit: user.monthlyLimit,
      role: user.role,
      status: 'active'
    }
  });
});

// ADMIN: Список всех пользователей
app.get('/admin/users', (req, res) => {
  const userList = Array.from(users.entries()).map(([apiKey, user]) => {
    const usage = userUsage.get(apiKey) || { count: 0, resetDate: new Date() };
    return {
      apiKey: apiKey,
      email: user.userEmail,
      monthlyLimit: user.monthlyLimit,
      currentUsage: usage.count,
      resetDate: usage.resetDate,
      status: user.status,
      role: user.role || 'user',
      createdAt: user.createdAt,
      serverId: user.serverId,
      channelId: user.channelId,
      salaiToken: "***hidden***"
    };
  });
  
  res.json({ users: userList, total: users.size });
});

// ADMIN: Получение деталей конкретного пользователя
app.get('/admin/users/:apiKey', (req, res) => {
  const { apiKey } = req.params;
  const user = users.get(apiKey);
  
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  const usage = userUsage.get(apiKey) || { count: 0, resetDate: new Date() };
  const history = generationHistory.get(apiKey) || [];
  
  res.json({
    ...user,
    currentUsage: usage.count,
    resetDate: usage.resetDate,
    history: history.slice(-10)
  });
});

// ADMIN: Обновление пользователя
app.put('/admin/users/:apiKey', (req, res) => {
  const { apiKey } = req.params;
  const updates = req.body;
  
  const user = users.get(apiKey);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  const allowedFields = ['monthlyLimit', 'status', 'role', 'userEmail'];
  const updatedUser = { ...user };
  
  allowedFields.forEach(field => {
    if (updates[field] !== undefined) {
      updatedUser[field] = updates[field];
    }
  });
  
  if (updatedUser.role === 'admin') {
    updatedUser.monthlyLimit = -1;
  }
  
  users.set(apiKey, updatedUser);
  
  console.log(`✏️ Пользователь обновлен: ${updatedUser.userEmail}`);
  
  res.json({ success: true, user: updatedUser });
});

// ADMIN: Удаление пользователя
app.delete('/admin/users/:apiKey', (req, res) => {
  const { apiKey } = req.params;
  
  if (!users.has(apiKey)) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  const user = users.get(apiKey);
  users.delete(apiKey);
  userUsage.delete(apiKey);
  generationHistory.delete(apiKey);
  userSessions.delete(apiKey);
  
  console.log(`🗑️ Пользователь удален: ${user.userEmail}`);
  
  res.json({ success: true, message: 'Пользователь удален' });
});

// ADMIN: Сброс лимитов пользователя
app.post('/admin/users/:apiKey/reset', (req, res) => {
  const { apiKey } = req.params;
  
  if (!users.has(apiKey)) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  userUsage.set(apiKey, { count: 0, resetDate: new Date() });
  
  console.log(`🔄 Лимиты сброшены для: ${users.get(apiKey).userEmail}`);
  
  res.json({ success: true, message: 'Лимиты сброшены' });
});

// ADMIN: Блокировка/разблокировка пользователя
app.post('/admin/users/:apiKey/toggle-block', (req, res) => {
  const { apiKey } = req.params;
  const user = users.get(apiKey);
  
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  user.status = user.status === 'blocked' ? 'active' : 'blocked';
  users.set(apiKey, user);
  
  console.log(`${user.status === 'blocked' ? '🔒' : '🔓'} Пользователь ${user.userEmail} ${user.status === 'blocked' ? 'заблокирован' : 'разблокирован'}`);
  
  res.json({ success: true, status: user.status });
});

// ADMIN: История генераций
app.get('/admin/history', (req, res) => {
  const allHistory = [];
  
  generationHistory.entries().forEach(([apiKey, history]) => {
    const user = users.get(apiKey);
    history.forEach(item => {
      allHistory.push({
        ...item,
        userEmail: user?.userEmail || 'Deleted User',
        apiKey: apiKey.substring(0, 8) + '...'
      });
    });
  });
  
  allHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  res.json({ history: allHistory.slice(0, 100) });
});

// USER: Генерация изображения (АСИНХРОННАЯ ВЕРСИЯ)
app.post('/api/generate', validateApiKey, async (req, res) => {
  try {
    const { prompt } = req.body;
    const { user, apiKey } = req;
    
    if (!prompt) {
      return res.status(400).json({
        error: 'Параметр prompt обязателен',
        example: { prompt: 'beautiful sunset over mountains' }
      });
    }
    
    // Генерируем уникальный task_id
    const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substring(7);
    
    console.log(`🎨 Запуск генерации для ${user.userEmail}: "${prompt}" (Task: ${taskId})`);
    
    // Сохраняем начальный статус
    activeTasks.set(taskId, {
      status: 'processing',
      prompt: prompt,
      user: user.userEmail,
      apiKey: apiKey,  // Добавлено для проверки прав доступа
      startedAt: new Date().toISOString()
    });
    
    // Сразу возвращаем task_id
    res.json({
      success: true,
      task_id: taskId,
      status: 'processing',
      message: 'Генерация запущена'
    });
    
    // Запускаем генерацию в фоне
    (async () => {
      try {
        let client = userSessions.get(apiKey);
        if (!client) {
          client = await getMidjourneyClient(user);
          userSessions.set(apiKey, client);
        }
        
        const result = await client.Imagine(prompt, (uri, progress) => {
          console.log(`${user.userEmail} - Прогресс: ${progress}`);
          const task = activeTasks.get(taskId);
          if (task) {
            task.progress = progress;
            activeTasks.set(taskId, task);
          }
        });
        
        // Обновляем статус на completed
        activeTasks.set(taskId, {
          status: 'completed',
          prompt: prompt,
          image_url: result.uri,
          midjourney_id: result.id,
          user: user.userEmail,
          apiKey: apiKey,
          completedAt: new Date().toISOString()
        });
        
        // Обновляем счетчики и историю
        let currentUsage = userUsage.get(apiKey) || { count: 0, resetDate: new Date() };
        if (user.role !== 'admin') {
          currentUsage.count += 1;
          userUsage.set(apiKey, currentUsage);
        }
        
        const historyItem = {
          prompt,
          imageUrl: result.uri,
          taskId: result.id,
          timestamp: new Date().toISOString()
        };
        
        const history = generationHistory.get(apiKey) || [];
        history.push(historyItem);
        generationHistory.set(apiKey, history);
        
        console.log(`✅ Генерация завершена: ${taskId} -> ${result.id}`);
        
      } catch (error) {
        console.error(`❌ Ошибка генерации для ${taskId}:`, error.message);
        activeTasks.set(taskId, {
          status: 'failed',
          error: error.message,
          prompt: prompt,
          user: user.userEmail,
          apiKey: apiKey,
          failedAt: new Date().toISOString()
        });
      }
    })();
    
  } catch (error) {
    console.error('❌ Ошибка запуска генерации:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// USER: Проверка статуса генерации (НОВЫЙ ENDPOINT!)
app.get('/api/task/:taskId', validateApiKey, (req, res) => {
  const { taskId } = req.params;
  const task = activeTasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({
      error: 'Задача не найдена',
      task_id: taskId
    });
  }
  
  // Проверяем что это задача текущего пользователя
  if (task.apiKey !== req.apiKey && req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Доступ запрещен'
    });
  }
  
  const response = {
    task_id: taskId,
    status: task.status,
    prompt: task.prompt
  };
  
  if (task.status === 'completed') {
    response.image_url = task.image_url;
    response.midjourney_id = task.midjourney_id;
    response.task_id = task.midjourney_id;  // Для совместимости с upscale
    
    // Удаляем выполненную задачу через 5 минут
    setTimeout(() => {
      activeTasks.delete(taskId);
    }, 300000);
  } else if (task.status === 'failed') {
    response.error = task.error;
  } else if (task.progress !== undefined) {
    response.progress = task.progress;
  }
  
  res.json(response);
});

// ADMIN: Список всех активных задач (НОВЫЙ ENDPOINT!)
app.get('/api/tasks', validateApiKey, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Только для администраторов' });
  }
  
  const tasks = Array.from(activeTasks.entries()).map(([id, task]) => ({
    task_id: id,
    status: task.status,
    user: task.user,
    prompt: task.prompt,
    progress: task.progress,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    error: task.error
  }));
  
  res.json({ tasks, total: tasks.length });
});

// USER: Upscale изображения с поддержкой бинарного вывода
app.post('/api/upscale', validateApiKey, async (req, res) => {
  try {
    const { task_id, index } = req.body;
    const { user, apiKey } = req;
    
    if (!task_id || !index) {
      return res.status(400).json({
        error: 'Параметры task_id и index обязательны',
        example: { 
          task_id: "1379740446099771424", 
          index: 1,
          note: "index должен быть от 1 до 4"
        }
      });
    }
    
    if (index < 1 || index > 4) {
      return res.status(400).json({
        error: 'Параметр index должен быть от 1 до 4',
        detail: '1 - верхняя левая, 2 - верхняя правая, 3 - нижняя левая, 4 - нижняя правая'
      });
    }
    
    console.log(`🔍 Upscale для ${user.userEmail}: задача ${task_id}, картинка ${index}`);
    
    const history = generationHistory.get(apiKey) || [];
    const originalTask = history.find(item => item.taskId === task_id);
    
    if (!originalTask || !originalTask.imageUrl) {
      return res.status(404).json({
        error: 'Задача не найдена. Сначала сгенерируйте изображение.'
      });
    }
    
    const urlParts = originalTask.imageUrl.split('/');
    const filename = urlParts[urlParts.length - 1];
    const hashMatch = filename.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
    const hash = hashMatch ? hashMatch[1] : task_id;
    
    console.log(`📌 Извлечен hash: ${hash}`);
    
    let client = userSessions.get(apiKey);
    if (!client) {
      client = await getMidjourneyClient(user);
      userSessions.set(apiKey, client);
    }
    
    const result = await client.Upscale({
      index: index,
      msgId: task_id,
      hash: hash,
      flags: 0,
      loading: (uri, progress) => {
        console.log(`${user.userEmail} - Upscale прогресс: ${progress}%`);
      }
    });
    
    console.log(`✅ Upscale завершен для ${user.userEmail}`);
    
    const needBinary = req.headers['x-make-binary'] === 'true' || 
                      req.query.binary === 'true' ||
                      req.headers['accept'] === 'application/octet-stream';
    
    if (needBinary) {
      console.log(`📥 Бинарный режим активирован`);
      
      try {
        const https = require('https');
        const url = require('url');
        const imageUrl = new URL(result.uri);
        
        https.get(imageUrl, (imageResponse) => {
          if (imageResponse.statusCode !== 200) {
            throw new Error(`HTTP error! status: ${imageResponse.statusCode}`);
          }
          
          const chunks = [];
          
          imageResponse.on('data', (chunk) => {
            chunks.push(chunk);
          });
          
          imageResponse.on('end', () => {
            const imageBuffer = Buffer.concat(chunks);
            
            console.log(`✅ Загружено изображение: ${imageBuffer.length} байт`);
            
            res.set({
              'Content-Type': 'image/png',
              'Content-Length': imageBuffer.length,
              'Content-Disposition': `attachment; filename="midjourney_upscaled_${index}_${Date.now()}.png"`,
              'X-Image-URL': result.uri,
              'X-Task-ID': task_id,
              'X-Selected-Index': index.toString()
            });
            
            res.send(imageBuffer);
          });
          
          imageResponse.on('error', (error) => {
            console.error('⚠️ Ошибка загрузки изображения:', error.message);
            res.json({
              success: true,
              image_url: result.uri,
              error: 'Не удалось загрузить изображение для бинарной отправки'
            });
          });
        }).on('error', (error) => {
          console.error('⚠️ Ошибка HTTPS запроса:', error.message);
          res.json({
            success: true,
            image_url: result.uri,
            error: 'Не удалось загрузить изображение для бинарной отправки'
          });
        });
        
        return;
        
      } catch (error) {
        console.error('⚠️ Ошибка в бинарном режиме:', error.message);
        return res.json({
          success: true,
          image_url: result.uri,
          error: 'Не удалось загрузить изображение для бинарной отправки'
        });
      }
    }
    
    const historyItem = {
      action: 'upscale',
      originalTaskId: task_id,
      selectedIndex: index,
      imageUrl: result.uri,
      timestamp: new Date().toISOString()
    };
    
    history.push(historyItem);
    generationHistory.set(apiKey, history);
    
    res.json({
      success: true,
      image_url: result.uri,
      original_task_id: task_id,
      selected_index: index,
      description: `Картинка ${index} увеличена`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Ошибка upscale:', error);
    console.error('Детали:', error.message);
    
    res.json({
      success: false,
      error: error.message,
      fallback: true,
      message: "Используйте альтернативный метод обработки"
    });
  }
});

// Админ панель (HTML интерфейс)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Корневой роут
app.get('/', (req, res) => {
  res.json({
    name: 'Midjourney API Service',
    version: '2.1.0',
    endpoints: {
      health: '/health',
      admin: '/admin',
      api: {
        generate: 'POST /api/generate (async)',
        status: 'GET /api/task/:taskId',      // НОВЫЙ!
        tasks: 'GET /api/tasks (admin only)', // НОВЫЙ!
        upscale: 'POST /api/upscale'
      }
    },
    changes: {
      '2.1.0': 'Добавлена асинхронная генерация с проверкой статуса'
    }
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;

init().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Супер Midjourney API запущен на порту ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`👥 Admin панель: http://localhost:${PORT}/admin`);
    console.log(`🎨 API генерации: POST http://localhost:${PORT}/api/generate`);
    console.log(`📍 API статуса: GET http://localhost:${PORT}/api/task/:taskId`);
    console.log(`🔍 API upscale: POST http://localhost:${PORT}/api/upscale`);
    console.log(`🌍 Среда: ${process.env.NODE_ENV || 'development'}`);
  });
});
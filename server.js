// server.js - Супер продвинутая версия с PostgreSQL и исправлениями для временных вложений
const express = require('express');
const { Midjourney } = require('midjourney');
const path = require('path');
const { initDatabase, users, history, fullGenerations } = require('./database');
require('dotenv').config();

const app = express();
const activeTasks = new Map(); // Хранилище активных задач
const userSessions = new Map(); // Кеш Midjourney клиентов

app.use(express.json());
app.use(express.static('public'));

// Защита токенов в логах
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Функция для скрытия токенов
function hideTokens(str) {
  if (typeof str === 'string') {
    // Скрываем Discord токены
    return str.replace(/MTM3[A-Za-z0-9\-._]{50,}/g, '***HIDDEN_TOKEN***');
  }
  return str;
}

// Перехватываем console.log
console.log = function(...args) {
  const cleanArgs = args.map(arg => {
    if (typeof arg === 'string') {
      return hideTokens(arg);
    } else if (typeof arg === 'object' && arg !== null) {
      try {
        const str = JSON.stringify(arg);
        const cleaned = hideTokens(str);
        return JSON.parse(cleaned);
      } catch {
        return arg;
      }
    }
    return arg;
  });
  originalConsoleLog.apply(console, cleanArgs);
};

// Перехватываем console.error
console.error = function(...args) {
  const cleanArgs = args.map(arg => {
    if (typeof arg === 'string') {
      return hideTokens(arg);
    } else if (typeof arg === 'object' && arg !== null) {
      try {
        const str = JSON.stringify(arg);
        const cleaned = hideTokens(str);
        return JSON.parse(cleaned);
      } catch {
        return arg;
      }
    }
    return arg;
  });
  originalConsoleError.apply(console, cleanArgs);
};

// Функция генерации API ключей
function generateApiKey() {
  return 'mj_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Middleware для проверки API ключей
async function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API ключ обязателен. Добавьте заголовок X-API-Key' });
  }
  
  try {
    const user = await users.getByApiKey(apiKey);
    
    if (!user) {
      return res.status(401).json({ error: 'Недействительный API ключ' });
    }
    
    // Проверяем статус пользователя
    if (user.is_blocked) {
      return res.status(403).json({ error: 'Ваш аккаунт заблокирован' });
    }
    
    // Для админов пропускаем проверку лимитов
    if (user.is_admin) {
      req.user = user;
      req.apiKey = apiKey;
      return next();
    }
    
    // Проверяем лимиты для обычных пользователей
    if (user.usage_count >= user.monthly_limit) {
      return res.status(429).json({ 
        error: 'Превышен месячный лимит генераций',
        limit: user.monthly_limit,
        used: user.usage_count,
        resetDate: user.reset_date
      });
    }
    
    req.user = user;
    req.apiKey = apiKey;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

// Функция создания Midjourney клиента
async function getMidjourneyClient(user) {
  try {
    const client = new Midjourney({
      ServerId: user.server_id,
      ChannelId: user.channel_id,
      SalaiToken: user.salai_token,
      Debug: false,
      Ws: true
    });
    
    await client.init();
    
    // Добавляем обработку ошибок WebSocket
    if (client.ws) {
      client.ws.on('error', (error) => {
        console.error('❌ WebSocket ошибка:', error.message);
        // Удаляем клиент из кеша при ошибке
        const apiKey = Array.from(userSessions.entries())
          .find(([key, val]) => val === client)?.[0];
        if (apiKey) {
          userSessions.delete(apiKey);
        }
      });
      
      client.ws.on('close', () => {
        console.log('🔌 WebSocket соединение закрыто');
        // Удаляем клиент из кеша при закрытии
        const apiKey = Array.from(userSessions.entries())
          .find(([key, val]) => val === client)?.[0];
        if (apiKey) {
          userSessions.delete(apiKey);
        }
      });
    }
    
    return client;
  } catch (error) {
    console.error('❌ Ошибка создания Midjourney клиента:', error);
    throw error;
  }
}

// Функция для ожидания постоянного URL вместо временного
async function waitForPermanentAttachment(messageId, channelId, salaiToken, maxAttempts = 20) {
  console.log('⏳ Ожидаем постоянное вложение...');
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Ждем 10 секунд между попытками
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      
      const response = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`, {
        headers: {
          'Authorization': salaiToken,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });
      
      if (response.ok) {
        const message = await response.json();
        
        if (message.attachments && message.attachments.length > 0) {
          const attachment = message.attachments[0];
          
          // Проверяем, что вложение не временное
          if (!attachment.url.includes('ephemeral')) {
            console.log(`✅ Получено постоянное вложение на попытке ${attempt + 1}`);
            return {
              success: true,
              url: attachment.url,
              proxy_url: attachment.proxy_url
            };
          } else {
            console.log(`⏳ Попытка ${attempt + 1}/${maxAttempts}: все еще временное вложение`);
          }
        }
      }
    } catch (error) {
      console.error(`Ошибка при попытке ${attempt + 1}:`, error.message);
    }
  }
  
  return {
    success: false,
    error: 'Не удалось получить постоянное вложение'
  };
}

// === API ENDPOINTS ===

// Проверка статуса системы
app.get('/health', async (req, res) => {
  try {
    const totalUsers = await users.count();
    const stats = await users.getStats();
    
    res.json({
      status: 'ok',
      database: 'PostgreSQL',
      stats: {
        totalUsers: totalUsers,
        activeUsers: stats.activeUsers,
        blockedUsers: stats.blockedUsers,
        adminUsers: stats.adminUsers,
        activeSessions: userSessions.size,
        activeTasks: activeTasks.size
      },
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Создание нового пользователя
app.post('/admin/users', async (req, res) => {
  const { server_id, channel_id, salai_token, monthly_limit = 100, username, is_admin = false } = req.body;
  
  if (!server_id || !channel_id || !salai_token || !username) {
    return res.status(400).json({
      error: 'Требуются: server_id, channel_id, salai_token, username'
    });
  }
  
  try {
    const apiKey = generateApiKey();
    const user = await users.create({
      api_key: apiKey,
      username,
      server_id,
      channel_id,
      salai_token,
      monthly_limit: is_admin ? -1 : monthly_limit,
      is_admin
    });
    
    console.log(`👤 Новый ${is_admin ? 'админ' : 'пользователь'} создан: ${username}`);
    
    res.json({
      success: true,
      apiKey: apiKey,
      user: {
        username: username,
        monthlyLimit: user.monthly_limit,
        is_admin: user.is_admin,
        status: 'active'
      }
    });
  } catch (error) {
    console.error('Ошибка создания пользователя:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Список всех пользователей
app.get('/admin/users', async (req, res) => {
  try {
    const userList = await users.getAll();
    
    const formattedUsers = userList.map(user => ({
      apiKey: user.api_key,
      username: user.username,
      monthlyLimit: user.monthly_limit,
      currentUsage: user.usage_count,
      resetDate: user.reset_date,
      status: user.is_blocked ? 'blocked' : 'active',
      role: user.is_admin ? 'admin' : 'user',
      createdAt: user.created_at,
      serverId: user.server_id,
      channelId: user.channel_id,
      salaiToken: "***hidden***"
    }));
    
    res.json({ users: formattedUsers, total: formattedUsers.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Получение деталей конкретного пользователя
app.get('/admin/users/:apiKey', async (req, res) => {
  const { apiKey } = req.params;
  
  try {
    const user = await users.getByApiKey(apiKey);
    
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    const userHistory = await history.getByUser(apiKey, 10);
    
    res.json({
      ...user,
      salai_token: "***hidden***",
      currentUsage: user.usage_count,
      resetDate: user.reset_date,
      history: userHistory
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Обновление пользователя
app.put('/admin/users/:apiKey', async (req, res) => {
  const { apiKey } = req.params;
  const { monthly_limit, is_admin } = req.body;
  
  try {
    const user = await users.getByApiKey(apiKey);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    if (monthly_limit !== undefined) {
      await users.updateLimit(apiKey, is_admin ? -1 : monthly_limit);
    }
    
    const updatedUser = await users.getByApiKey(apiKey);
    
    console.log(`✏️ Пользователь обновлен: ${updatedUser.username}`);
    
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Удаление пользователя
app.delete('/admin/users/:apiKey', async (req, res) => {
  const { apiKey } = req.params;
  
  try {
    const user = await users.getByApiKey(apiKey);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    await users.delete(apiKey);
    userSessions.delete(apiKey);
    
    console.log(`🗑️ Пользователь удален: ${user.username}`);
    
    res.json({ success: true, message: 'Пользователь удален' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Сброс лимитов пользователя
app.post('/admin/users/:apiKey/reset', async (req, res) => {
  const { apiKey } = req.params;
  
  try {
    const user = await users.getByApiKey(apiKey);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    await users.resetUsage(apiKey);
    
    console.log(`🔄 Лимиты сброшены для: ${user.username}`);
    
    res.json({ success: true, message: 'Лимиты сброшены' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Блокировка/разблокировка пользователя
app.post('/admin/users/:apiKey/toggle-block', async (req, res) => {
  const { apiKey } = req.params;
  
  try {
    const user = await users.getByApiKey(apiKey);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    const newStatus = !user.is_blocked;
    await users.setBlocked(apiKey, newStatus);
    
    console.log(`${newStatus ? '🔒' : '🔓'} Пользователь ${user.username} ${newStatus ? 'заблокирован' : 'разблокирован'}`);
    
    res.json({ success: true, status: newStatus ? 'blocked' : 'active' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: История генераций
app.get('/admin/history', async (req, res) => {
  try {
    const allHistory = await history.getAll(100);
    
    res.json({ history: allHistory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    
    console.log(`🎨 Запуск генерации для ${user.username}: "${prompt}" (Task: ${taskId})`);
    
    // Сохраняем начальный статус
    activeTasks.set(taskId, {
      status: 'processing',
      prompt: prompt,
      user: user.username,
      apiKey: apiKey,
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
          console.log(`${user.username} - Прогресс: ${progress}`);
          const task = activeTasks.get(taskId);
          if (task) {
            task.progress = progress;
            activeTasks.set(taskId, task);
          }
        });
        
        // Проверяем на временное вложение и ждем постоянное
        let finalUrl = result.uri;
        let hash = result.hash || extractHashFromUrl(result.uri);
        
        if (result.uri.includes('ephemeral')) {
          console.log('⚠️ Получено временное вложение, ждем постоянное...');
          
          const permanentResult = await waitForPermanentAttachment(
            result.id,
            user.channel_id,
            user.salai_token,
            20 // 20 попыток по 10 секунд = 3+ минуты
          );
          
          if (permanentResult.success) {
            finalUrl = permanentResult.url;
            // Обновляем hash из нового URL
            hash = extractHashFromUrl(finalUrl);
          } else {
            console.warn('⚠️ Не удалось получить постоянное вложение, используем временное');
          }
        }
        
        // Обновляем статус на completed
        activeTasks.set(taskId, {
          status: 'completed',
          prompt: prompt,
          image_url: finalUrl,
          midjourney_id: result.id,
          hash: hash,
          user: user.username,
          apiKey: apiKey,
          completedAt: new Date().toISOString(),
          is_ephemeral: finalUrl.includes('ephemeral')
        });
        
        // Обновляем счетчики и историю
        if (!user.is_admin) {
          await users.incrementUsage(apiKey);
        }
        
        await history.add(apiKey, prompt, JSON.stringify({
          imageUrl: finalUrl,
          taskId: result.id,
          hash: hash
        }));
        
        console.log(`✅ Генерация завершена: ${taskId} -> ${result.id}`);
        console.log(`📎 Тип вложения: ${finalUrl.includes('ephemeral') ? 'ВРЕМЕННОЕ' : 'ПОСТОЯННОЕ'}`);
        
      } catch (error) {
        console.error(`❌ Ошибка генерации для ${taskId}:`, error.message);
        activeTasks.set(taskId, {
          status: 'failed',
          error: error.message,
          prompt: prompt,
          user: user.username,
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

// USER: Проверка статуса генерации
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
  if (task.apiKey !== req.apiKey && !req.user.is_admin) {
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
    response.is_ephemeral = task.is_ephemeral;
    
    // Если изображение все еще временное, добавляем рекомендацию подождать
    if (response.is_ephemeral) {
      response.recommendation = 'Image has ephemeral attachment. Please wait a moment and try again.';
    }
    
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

// ADMIN: Список всех активных задач
app.get('/api/tasks', validateApiKey, (req, res) => {
  if (!req.user.is_admin) {
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

// Генерация nonce как в Discord
function generateNonce() {
  const timestamp = Date.now();
  return timestamp.toString();
}

// Генерация session ID
function generateSessionId() {
  const hex = 'abcdef0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += hex[Math.floor(Math.random() * hex.length)];
  }
  return result;
}

// Генерация правильного X-Super-Properties
function generateSuperProperties() {
  const properties = {
    os: "Mac OS X",
    browser: "Discord Client",
    release_channel: "stable",
    client_version: "0.0.309",
    os_version: "23.2.0",
    os_arch: "arm64",
    app_arch: "arm64",
    system_locale: "en-US",
    browser_user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.309 Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36",
    browser_version: "28.2.10",
    client_build_number: 306178,
    native_build_number: 50968,
    client_event_source: null
  };
  
  return Buffer.from(JSON.stringify(properties)).toString('base64');
}

// Ожидание результата upscale
async function waitForUpscaleResult(channelId, salaiToken, originalMessageId, index, maxAttempts = 30) {
  console.log(`⏳ Ожидаем результат upscale для сообщения ${originalMessageId}, картинка ${index}`);
  
  // Небольшая начальная задержка
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const response = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages?limit=50`, {
        headers: {
          'Authorization': salaiToken,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.309 Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36'
        }
      });
      if (!response.ok) continue;
      const messages = await response.json();
      for (const msg of messages) {
        if (msg.author.id === '936929561302675456' && msg.attachments && msg.attachments.length > 0) {
          // Проверяем по содержимому или reference
          if (msg.content && (msg.content.includes(`Image #${index}`) || msg.content.includes('Upscaled by'))) {
            console.log('✅ Найден результат upscale по содержимому!');
            return { success: true, url: msg.attachments[0].url, proxy_url: msg.attachments[0].proxy_url, message_id: msg.id };
          }
          if (msg.reference && msg.reference.message_id === originalMessageId) {
            console.log('✅ Найден результат upscale по reference!');
            return { success: true, url: msg.attachments[0].url, proxy_url: msg.attachments[0].proxy_url, message_id: msg.id };
          }
        }
      }
    } catch (error) {
      console.error(`Попытка ${attempt + 1}: ${error.message}`);
    }
  }
  return { success: false, error: 'Timeout waiting for upscale result' };
}

// Исправленная функция upscale с поддержкой временных вложений
async function customUpscale(messageId, index, hash, user) {
  console.log('🚀 Используем собственную реализацию upscale');
  console.log('📋 Параметры upscale:', {
    messageId,
    index,
    hash,
    serverId: user.server_id,
    channelId: user.channel_id,
    username: user.username
  });
  
  // Проверяем возраст сообщения
  const messageTimestamp = getTimestampFromSnowflake(messageId);
  const messageAge = Date.now() - messageTimestamp;
  console.log(`  Возраст сообщения: ${Math.floor(messageAge / 1000)} секунд`);

  if (messageAge > 900000) { // 15 минут
    throw new Error('Message too old for upscale (max 15 minutes)');
  }
  
  // Для временных вложений нужен особый подход
  const customIds = [
    `MJ::JOB::upsample::${index}::${hash}`,
    `MJ::JOB::upsample_v6::${index}::${hash}::SOLO`,
    `MJ::JOB::upsample_v5::${index}::${hash}`,
    `MJ::JOB::upsample_v6_2x::${index}::${hash}::SOLO`,
    `MJ::JOB::high_variation::${index}::${hash}::1`,
    `MJ::JOB::low_variation::${index}::${hash}::1`
  ];
  
  let lastError = null;
  
  for (const customId of customIds) {
    const nonce = generateNonce();
    const sessionId = generateSessionId();
    
    const payload = {
      type: 3,
      nonce: nonce,
      guild_id: user.server_id,
      channel_id: user.channel_id,
      message_flags: 0,
      message_id: messageId,
      application_id: '936929561302675456',
      session_id: sessionId,
      data: { 
        component_type: 2, 
        custom_id: customId 
      }
    };

    console.log('📤 Пробуем custom_id:', customId);
    
    try {
      const response = await fetch('https://discord.com/api/v9/interactions', {
        method: 'POST',
        headers: {
          'Authorization': user.salai_token,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.309 Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Origin': 'https://discord.com',
          'Pragma': 'no-cache',
          'Referer': `https://discord.com/channels/${user.server_id}/${user.channel_id}`,
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"macOS"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Debug-Options': 'bugReporterEnabled',
          'X-Discord-Locale': 'en-US',
          'X-Discord-Timezone': 'Europe/Moscow',
          'X-Super-Properties': generateSuperProperties()
        },
        body: JSON.stringify(payload)
      });

      const statusCode = response.status;
      const responseText = await response.text();
      console.log(`📥 Discord ответ: ${statusCode}`);

      if (responseText) {
        console.log(`📄 Discord сообщение: ${responseText.substring(0, 200)}`);
      }
      
      if (statusCode === 204) {
        console.log('✅ Команда upscale принята Discord!');
        
        // Увеличиваем время ожидания результата
        const result = await waitForUpscaleResult(user.channel_id, user.salai_token, messageId, index, 45);
        
        if (result.success) {
          return { 
            uri: result.url, 
            proxy_url: result.proxy_url, 
            success: true,
            message_id: result.message_id
          };
        }
        throw new Error(result.error || 'Failed to get upscale result');
      } else if (statusCode === 404) {
        lastError = 'Message not found';
        continue;
      } else if (statusCode === 429) {
        // Rate limit - ждем и пробуем снова
        const retryAfter = JSON.parse(responseText).retry_after || 1;
        console.log(`⏳ Rate limit, ждем ${retryAfter} секунд...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      } else {
        lastError = `Discord API error: ${statusCode} - ${responseText}`;
        continue;
      }
    } catch (error) {
      lastError = error.message;
      continue;
    }
  }
  
  // Если все попытки не удались
  throw new Error(lastError || 'Failed to upscale with all custom_id variants');
}

// Извлечение hash из URL изображения
function extractHashFromUrl(url) {
  if (!url) return null;
  const hashMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
  return hashMatch ? hashMatch[1] : null;
}

// Проверка возраста сообщения Discord
function getTimestampFromSnowflake(snowflake) {
  const DISCORD_EPOCH = 1420070400000;
  const timestamp = Number((BigInt(snowflake) >> 22n)) + DISCORD_EPOCH;
  return timestamp;
}

// USER: Upscale изображения с поддержкой бинарного вывода
app.post('/api/upscale', validateApiKey, async (req, res) => {
  try {
    const { task_id, index } = req.body;
    const idx = parseInt(index, 10);
    const { user, apiKey } = req;
    
    if (!task_id || Number.isNaN(idx)) {
      return res.status(400).json({
        error: 'Параметры task_id и index обязательны',
        example: { 
          task_id: "1379740446099771424", 
          index: 1,
          note: "index должен быть от 1 до 4"
        }
      });
    }
    
    if (idx < 1 || idx > 4) {
      return res.status(400).json({
        error: 'Параметр index должен быть от 1 до 4',
        detail: '1 - верхняя левая, 2 - верхняя правая, 3 - нижняя левая, 4 - нижняя правая'
      });
    }
    
    console.log(`🔍 Upscale для ${user.username}: задача ${task_id}, картинка ${idx}`);
    
    // Проверяем возраст сообщения
    const messageAge = Date.now() - getTimestampFromSnowflake(task_id);
    const MAX_AGE = 15 * 60 * 1000; // 15 минут
    
    if (messageAge > MAX_AGE) {
      return res.status(400).json({
        error: 'Button expired. Discord buttons are only valid for 15 minutes after generation.',
        age_minutes: Math.floor(messageAge / 60000),
        max_age_minutes: 15
      });
    }
    
    // Проверяем в активных задачах
    const activeTask = Array.from(activeTasks.values()).find(task => 
      task.midjourney_id === task_id && task.status === 'completed'
    );
    
    // Если не нашли в активных, ищем в истории
    let hash = null;
    let imageUrl = null;
    
    if (activeTask) {
      imageUrl = activeTask.image_url;
      hash = activeTask.hash;
    } else {
      // Ищем в БД
      const historyRecords = await history.getByUser(apiKey, 50);
      const record = historyRecords.find(h => {
        try {
          const result = JSON.parse(h.result);
          return result.taskId === task_id;
        } catch {
          return false;
        }
      });
      
      if (record) {
        const result = JSON.parse(record.result);
        imageUrl = result.imageUrl;
        hash = result.hash;
      }
    }
    
    if (!imageUrl) {
      return res.status(404).json({
        error: 'Задача не найдена. Сначала сгенерируйте изображение.',
        details: 'Убедитесь, что используете правильный task_id из результата генерации'
      });
    }
    
    // Если нет hash, извлекаем из URL
    if (!hash) {
      hash = extractHashFromUrl(imageUrl);
    }
    
    if (!hash) {
      console.error('❌ Не удалось извлечь hash из URL:', imageUrl);
      return res.status(400).json({
        error: 'Не удалось извлечь hash из URL изображения',
        imageUrl: imageUrl
      });
    }
    
    console.log(`📌 Извлечен hash: ${hash}`);
    console.log(`🔗 URL изображения: ${imageUrl}`);
    
    // Если вложение временное, сначала пробуем получить постоянное
    if (imageUrl.includes('ephemeral')) {
      console.log('⚠️ Обнаружено временное вложение, пробуем получить постоянное...');
      
      const permanentResult = await waitForPermanentAttachment(
        task_id,
        user.channel_id,
        user.salai_token,
        10 // 10 попыток
      );
      
      if (permanentResult.success) {
        imageUrl = permanentResult.url;
        hash = extractHashFromUrl(imageUrl);
        console.log('✅ Получено постоянное вложение для upscale');
      } else {
        console.log('⚠️ Не удалось получить постоянное вложение');
        return res.status(400).json({
          error: 'Изображение имеет временное вложение. Подождите несколько минут и попробуйте снова.',
          suggestion: 'Временные вложения появляются при больших промптах. Попробуйте через 2-3 минуты.'
        });
      }
    }
    
    console.log('⏳ Ждем перед upscale...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    try {
      // Используем библиотеку midjourney для upscale
      let client = userSessions.get(apiKey);
      if (!client) {
        client = await getMidjourneyClient(user);
        userSessions.set(apiKey, client);
      }
      
      console.log('📚 Используем библиотеку Midjourney для upscale');
      
      const result = await client.Upscale({
        index: idx,
        msgId: task_id,
        hash: hash,
        flags: 0,
        loading: (uri, progress) => {
          console.log(`Upscale прогресс: ${progress}%`);
        }
      });
      
      if (!result || !result.uri) {
        throw new Error('Failed to get upscale result from Midjourney library');
      }
      
      console.log(`✅ Upscale завершен для ${user.username}`);
      
      const needBinary = req.headers['x-make-binary'] === 'true' || 
                        req.query.binary === 'true' ||
                        req.headers['accept'] === 'application/octet-stream';
      
      if (needBinary) {
        console.log(`📥 Бинарный режим активирован`);
        
        try {
          const https = require('https');
          const resultUrl = new URL(result.uri);
          
          https.get(resultUrl, (imageResponse) => {
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
                'Content-Disposition': `attachment; filename="midjourney_upscaled_${idx}_${Date.now()}.png"`,
                'X-Image-URL': result.uri,
                'X-Task-ID': task_id,
                'X-Selected-Index': idx.toString()
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
      
      // Сохраняем в историю
      await history.add(apiKey, `Upscale #${idx} of ${task_id}`, JSON.stringify({
        action: 'upscale',
        originalTaskId: task_id,
        selectedIndex: idx,
        imageUrl: result.uri
      }));
      
      res.json({
        success: true,
        image_url: result.uri,
        original_task_id: task_id,
        selected_index: idx,
        description: `Картинка ${idx} увеличена`,
        timestamp: new Date().toISOString()
      });
      
    } catch (upscaleError) {
      console.error('❌ Ошибка библиотеки Midjourney:', upscaleError.message);
      
      // Если библиотека не сработала, пробуем наш метод
      console.log('🔄 Пробуем альтернативный метод upscale...');
      
      try {
        const result = await customUpscale(task_id, idx, hash, user);
        
        console.log(`✅ Альтернативный upscale завершен для ${user.username}`);
        
        await history.add(apiKey, `Upscale #${idx} of ${task_id}`, JSON.stringify({
          action: 'upscale',
          originalTaskId: task_id,
          selectedIndex: idx,
          imageUrl: result.uri
        }));
        
        res.json({
          success: true,
          image_url: result.uri,
          original_task_id: task_id,
          selected_index: idx,
          description: `Картинка ${idx} увеличена`,
          timestamp: new Date().toISOString()
        });
        
      } catch (customError) {
        console.error('❌ Ошибка альтернативного метода:', customError.message);
        
        return res.status(400).json({
          success: false,
          error: 'Failed to upscale image. The message might be too old or have temporary attachment.',
          suggestions: [
            'Убедитесь, что с момента генерации прошло менее 15 минут',
            'Если изображение имело временное вложение, подождите 2-3 минуты',
            'Проверьте правильность task_id',
            'Попробуйте сгенерировать изображение заново'
          ],
          debug: {
            library_error: upscaleError.message,
            custom_error: customError.message
          }
        });
      }
    }
    
  } catch (error) {
    console.error('❌ Общая ошибка upscale:', error);
    console.error('Stack trace:', error.stack);
    
    res.status(500).json({
      success: false,
      error: error.message,
      type: 'general_error'
    });
  }
});

// USER: Полная генерация с автоматическим upscale всех вариантов
app.post('/api/generate-full', validateApiKey, async (req, res) => {
  try {
    const { 
      prompt, 
      upscale_all = true, 
      upscale_indexes = [1, 2, 3, 4],
      wait_before_upscale = 30000, // Увеличено до 30 секунд для больших промптов
      parallel_upscale = false // По умолчанию последовательный для избежания rate limit
    } = req.body;
    
    const { user, apiKey } = req;
    
    if (!prompt) {
      return res.status(400).json({
        error: 'Параметр prompt обязателен',
        example: { 
          prompt: 'beautiful sunset over mountains',
          upscale_all: true,
          upscale_indexes: [1, 2, 3, 4]
        }
      });
    }
    
    console.log(`🎨 ПОЛНАЯ генерация для ${user.username}: "${prompt}"`);
    console.log(`📋 Параметры: upscale_all=${upscale_all}, indexes=${upscale_indexes}, parallel=${parallel_upscale}`);
    
    // Генерируем уникальный ID для полной генерации
    const fullGenId = 'full_' + Date.now() + '_' + Math.random().toString(36).substring(7);
    
    // Сохраняем начальный статус
    const fullGeneration = {
      id: fullGenId,
      prompt: prompt,
      status: 'generating',
      username: user.username,
      apiKey: apiKey,
      startedAt: new Date().toISOString(),
      original: null,
      upscaled: []
    };
    
    await fullGenerations.create(fullGenId, fullGeneration);
    
    // Проверяем параметр wait ПЕРЕД отправкой ответа
    if (req.query.wait !== 'true') {
      // Обычный режим - сразу возвращаем ответ
      res.json({
        success: true,
        full_generation_id: fullGenId,
        status: 'processing',
        message: 'Полная генерация запущена. Используйте /api/generate-full/{id} для проверки статуса.'
      });
    }
    
    // Запускаем генерацию в фоне
    (async () => {
      try {
        // Шаг 1: Генерация исходного изображения
        console.log('📸 Шаг 1: Генерация исходного изображения...');
        
        let client = userSessions.get(apiKey);
        if (!client) {
          client = await getMidjourneyClient(user);
          userSessions.set(apiKey, client);
        }
        
        const generateResult = await client.Imagine(prompt, (uri, progress) => {
          console.log(`${user.username} - Генерация прогресс: ${progress}%`);
          fullGenerations.updateProgress(fullGenId, progress);
        });
        
        console.log(`✅ Изображение сгенерировано. ID: ${generateResult.id}`);
        
        // Проверяем и ждем постоянное вложение если нужно
        let finalImageUrl = generateResult.uri;
        let finalHash = generateResult.hash || extractHashFromUrl(generateResult.uri);
        
        if (generateResult.uri.includes('ephemeral')) {
          console.log('⚠️ Обнаружено временное вложение, ждем постоянное...');
          
          const permanentResult = await waitForPermanentAttachment(
            generateResult.id,
            user.channel_id,
            user.salai_token,
            25 // 25 попыток для больших промптов
          );
          
          if (permanentResult.success) {
            finalImageUrl = permanentResult.url;
            finalHash = extractHashFromUrl(finalImageUrl);
            console.log('✅ Получено постоянное вложение!');
          } else {
            console.warn('⚠️ Не удалось получить постоянное вложение');
            // Увеличиваем задержку перед upscale для временных вложений
            if (upscale_all) {
              console.log('⏳ Увеличиваем задержку перед upscale до 60 секунд...');
              fullGeneration.wait_before_upscale = 60000;
            }
          }
        }
        
        // Обновляем статус с результатом генерации
        fullGeneration.original = {
          midjourney_id: generateResult.id,
          image_url: finalImageUrl,
          hash: finalHash,
          generated_at: new Date().toISOString(),
          is_ephemeral: finalImageUrl.includes('ephemeral')
        };
        fullGeneration.status = 'generated';
        await fullGenerations.update(fullGenId, fullGeneration);
        
        // Обновляем счетчики использования
        if (!user.is_admin) {
          await users.incrementUsage(apiKey);
        }
        
        // Добавляем в историю
        await history.add(apiKey, prompt, JSON.stringify({
          action: 'full_generation',
          fullGenId: fullGenId,
          imageUrl: finalImageUrl,
          taskId: generateResult.id,
          hash: finalHash
        }));
        
        // Шаг 2: Upscale всех вариантов если нужно
        if (upscale_all && upscale_indexes.length > 0) {
          console.log(`🔍 Шаг 2: Upscale вариантов [${upscale_indexes.join(', ')}]...`);
          
          // Используем увеличенную задержку для временных вложений
          const actualWaitTime = fullGeneration.original.is_ephemeral ? 
            Math.max(wait_before_upscale, 60000) : wait_before_upscale;
          
          console.log(`⏳ Ждем ${actualWaitTime}мс перед началом upscale...`);
          
          fullGeneration.status = 'upscaling';
          await fullGenerations.update(fullGenId, fullGeneration);
          
          await new Promise(resolve => setTimeout(resolve, actualWaitTime));
          
          if (parallel_upscale) {
            // Параллельный upscale (осторожно с rate limits!)
            console.log('🚀 Запускаем параллельный upscale...');
            
            const upscalePromises = upscale_indexes.map(async (index, i) => {
              try {
                // Добавляем задержку между параллельными запросами
                await new Promise(resolve => setTimeout(resolve, i * 5000));
                
                console.log(`  📐 Начинаем upscale варианта ${index}...`);
                
                const upscaleResult = await customUpscale(
                  generateResult.id,
                  index,
                  finalHash,
                  user
                );
                
                if (upscaleResult && upscaleResult.uri) {
                  console.log(`  ✅ Вариант ${index} успешно увеличен`);
                  return {
                    index: index,
                    success: true,
                    image_url: upscaleResult.uri,
                    upscaled_at: new Date().toISOString()
                  };
                } else {
                  throw new Error('No result from upscale');
                }
                
              } catch (error) {
                console.error(`  ❌ Ошибка upscale варианта ${index}:`, error.message);
                return {
                  index: index,
                  success: false,
                  error: error.message
                };
              }
            });
            
            const upscaleResults = await Promise.allSettled(upscalePromises);
            
            upscaleResults.forEach((promiseResult, idx) => {
              if (promiseResult.status === 'fulfilled') {
                fullGeneration.upscaled.push(promiseResult.value);
              } else {
                fullGeneration.upscaled.push({
                  index: upscale_indexes[idx],
                  success: false,
                  error: promiseResult.reason?.message || 'Unknown error'
                });
              }
            });
            
          } else {
            // Последовательный upscale (рекомендуется)
            console.log('📝 Запускаем последовательный upscale...');
            
            for (const index of upscale_indexes) {
              try {
                console.log(`  📐 Upscale варианта ${index}...`);
                
                const upscaleResult = await customUpscale(
                  generateResult.id,
                  index,
                  finalHash,
                  user
                );
                
                if (upscaleResult && upscaleResult.uri) {
                  console.log(`  ✅ Вариант ${index} успешно увеличен`);
                  fullGeneration.upscaled.push({
                    index: index,
                    success: true,
                    image_url: upscaleResult.uri,
                    upscaled_at: new Date().toISOString()
                  });
                } else {
                  throw new Error('No result from upscale');
                }
                
                // Задержка между upscale для избежания rate limit
                if (index < upscale_indexes[upscale_indexes.length - 1]) {
                  await new Promise(resolve => setTimeout(resolve, 15000));
                }
                
              } catch (error) {
                console.error(`  ❌ Ошибка upscale варианта ${index}:`, error.message);
                fullGeneration.upscaled.push({
                  index: index,
                  success: false,
                  error: error.message
                });
              }
            }
          }
          
          // Сортируем по индексу
          fullGeneration.upscaled.sort((a, b) => a.index - b.index);
        }
        
        // Финальный статус
        fullGeneration.status = 'completed';
        fullGeneration.completedAt = new Date().toISOString();
        
        // Добавляем статистику
        fullGeneration.stats = {
          total_images: 1 + fullGeneration.upscaled.filter(u => u.success).length,
          successful_upscales: fullGeneration.upscaled.filter(u => u.success).length,
          failed_upscales: fullGeneration.upscaled.filter(u => !u.success).length,
          duration_seconds: Math.floor((new Date() - new Date(fullGeneration.startedAt)) / 1000)
        };
        
        await fullGenerations.update(fullGenId, fullGeneration);
        
        console.log(`✨ Полная генерация ${fullGenId} завершена!`);
        console.log(`📊 Статистика: ${fullGeneration.stats.total_images} изображений, ${fullGeneration.stats.successful_upscales} успешных upscale`);
        
      } catch (error) {
        console.error(`❌ Ошибка полной генерации ${fullGenId}:`, error.message);
        
        fullGeneration.status = 'failed';
        fullGeneration.error = error.message;
        fullGeneration.failedAt = new Date().toISOString();
        await fullGenerations.update(fullGenId, fullGeneration);
      }
    })();
    
    // Если wait=true, ждем результат
    if (req.query.wait === 'true') {
      console.log('⏳ Режим ожидания активирован...');
      
      const startTime = Date.now();
      const maxWaitTime = 300000; // 5 минут для больших промптов
      
      // Ждем завершения
      while (Date.now() - startTime < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const currentStatus = await fullGenerations.get(fullGenId);
        
        if (currentStatus && (currentStatus.status === 'completed' || currentStatus.status === 'failed')) {
          return res.json({
            success: currentStatus.status === 'completed',
            full_generation_id: fullGenId,
            status: currentStatus.status,
            prompt: currentStatus.prompt,
            original: currentStatus.original || {},
            upscaled: currentStatus.upscaled || [],
            stats: currentStatus.stats || {},
            error: currentStatus.error
          });
        }
      }
      
      // Таймаут
      const finalStatus = await fullGenerations.get(fullGenId);
      return res.json({
        success: false,
        full_generation_id: fullGenId,
        status: 'timeout',
        message: 'Generation is taking longer than expected. Use the status endpoint to check progress.',
        current_status: finalStatus ? finalStatus.status : 'unknown'
      });
    }
    
  } catch (error) {
    console.error('❌ Ошибка запуска полной генерации:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// USER: Получение статуса полной генерации
app.get('/api/generate-full/:fullGenId', validateApiKey, async (req, res) => {
  try {
    const { fullGenId } = req.params;
    const { user, apiKey } = req;
    
    const fullGeneration = await fullGenerations.get(fullGenId);
    
    if (!fullGeneration) {
      return res.status(404).json({
        error: 'Полная генерация не найдена',
        full_generation_id: fullGenId
      });
    }
    
    // Проверяем доступ
    if (fullGeneration.apiKey !== apiKey && !user.is_admin) {
      return res.status(403).json({
        error: 'Доступ запрещен'
      });
    }
    
    // Формируем ответ
    const response = {
      success: true,
      full_generation_id: fullGenId,
      status: fullGeneration.status,
      prompt: fullGeneration.prompt
    };
    
    // Добавляем прогресс если идет генерация
    if (fullGeneration.status === 'generating' && fullGeneration.progress !== undefined) {
      response.progress = fullGeneration.progress;
    }
    
    // Добавляем оригинал если есть
    if (fullGeneration.original) {
      response.original = {
        prompt: fullGeneration.prompt,
        image_url: fullGeneration.original.image_url,
        midjourney_id: fullGeneration.original.midjourney_id
      };
    }
    
    // Добавляем upscaled если есть
    if (fullGeneration.upscaled && fullGeneration.upscaled.length > 0) {
      response.upscaled = fullGeneration.upscaled;
    }
    
    // Добавляем статистику если завершено
    if (fullGeneration.status === 'completed' && fullGeneration.stats) {
      response.stats = fullGeneration.stats;
    }
    
    // Добавляем ошибку если есть
    if (fullGeneration.error) {
      response.error = fullGeneration.error;
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('Ошибка получения статуса полной генерации:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ADMIN: Список всех полных генераций
app.get('/api/generate-full', validateApiKey, async (req, res) => {
  try {
    let generations;
    
    if (!req.user.is_admin) {
      // Для обычных пользователей показываем только их генерации
      generations = await fullGenerations.getByUser(req.apiKey);
    } else {
      // Для админов показываем все
      generations = await fullGenerations.getAll(100);
    }
    
    res.json({
      generations: generations,
      total: generations.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Админ панель (HTML интерфейс)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// USER: Получение информации о пользователе
app.get('/api/user/info', validateApiKey, async (req, res) => {
  const { user, apiKey } = req;
  
  res.json({
    success: true,
    username: user.username,
    email: user.username,
    role: user.is_admin ? 'admin' : 'user',
    status: user.is_blocked ? 'blocked' : 'active',
    monthlyLimit: user.monthly_limit,
    currentUsage: user.usage_count,
    remainingCredits: user.monthly_limit === -1 ? 'unlimited' : Math.max(0, user.monthly_limit - user.usage_count),
    resetDate: user.reset_date,
    createdAt: user.created_at
  });
});

// Корневой роут
app.get('/', (req, res) => {
  res.json({
    name: 'Midjourney API Service',
    version: '3.0.0',
    database: 'PostgreSQL',
    endpoints: {
      health: '/health',
      admin: '/admin',
      api: {
        userInfo: 'GET /api/user/info',
        generate: 'POST /api/generate (async)',
        status: 'GET /api/task/:taskId',
        tasks: 'GET /api/tasks (admin only)',
        upscale: 'POST /api/upscale',
        generateFull: 'POST /api/generate-full (with auto upscale)',
        generateFullStatus: 'GET /api/generate-full/:fullGenId',
        generateFullList: 'GET /api/generate-full'
      }
    },
    changes: {
      '3.0.0': 'Миграция на PostgreSQL, улучшенная обработка временных вложений',
      '2.2.1': 'Добавлена поддержка параметра wait=true для синхронного ожидания результата',
      '2.2.0': 'Добавлен endpoint для полной генерации с автоматическим upscale всех вариантов'
    }
  });
});

// ТЕСТ: Проверка сообщения Discord
app.get('/api/test/message/:messageId', validateApiKey, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { user } = req;
    
    console.log(`🔍 Проверяем сообщения в канале для ${messageId}`);
    
    const response = await fetch(`https://discord.com/api/v9/channels/${user.channel_id}/messages?limit=10`, {
      headers: {
        'Authorization': user.salai_token,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      return res.status(response.status).json({
        error: `Discord API error: ${response.status}`,
        message: await response.text()
      });
    }
    
    const messages = await response.json();
    
    // Ищем наше сообщение
    const targetMessage = messages.find(msg => msg.id === messageId);
    
    if (!targetMessage) {
      return res.json({
        error: 'Message not found in recent messages',
        recent_message_ids: messages.map(m => m.id),
        searched_id: messageId
      });
    }
    
    // Извлекаем информацию о кнопках
    const components = targetMessage.components || [];
    const buttons = [];
    
    components.forEach(row => {
      if (row.components) {
        row.components.forEach(btn => {
          if (btn.custom_id) {
            buttons.push({
              label: btn.label || btn.emoji?.name || 'No label',
              custom_id: btn.custom_id,
              style: btn.style,
              disabled: btn.disabled
            });
          }
        });
      }
    });
    
    res.json({
      message_id: targetMessage.id,
      author: targetMessage.author?.username || 'Unknown',
      content: targetMessage.content || '',
      has_attachments: (targetMessage.attachments || []).length > 0,
      attachment_url: targetMessage.attachments?.[0]?.url,
      is_ephemeral: targetMessage.attachments?.[0]?.url?.includes('ephemeral') || false,
      components_count: components.length,
      buttons: buttons,
      created_at: targetMessage.timestamp,
      message_age_seconds: Math.floor((Date.now() - new Date(targetMessage.timestamp).getTime()) / 1000)
    });
    
  } catch (error) {
    console.error('Ошибка проверки сообщения:', error);
    res.status(500).json({ error: error.message });
  }
});

// Запуск сервера
const PORT = process.env.PORT || 8080;

// Инициализация и запуск
async function start() {
  try {
    // Инициализируем базу данных
    await initDatabase();
    console.log('✅ База данных PostgreSQL инициализирована');
    
    // Запускаем периодический сброс лимитов
    setInterval(async () => {
      try {
        await users.resetMonthlyUsage();
        console.log('🔄 Проверка месячных лимитов выполнена');
      } catch (error) {
        console.error('❌ Ошибка сброса лимитов:', error);
      }
    }, 3600000); // Каждый час
    
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Midjourney API запущен на порту ${PORT}`);
      console.log(`📊 База данных: PostgreSQL`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
      console.log(`👥 Admin панель: http://localhost:${PORT}/admin`);
      console.log(`🎨 API генерации: POST http://localhost:${PORT}/api/generate`);
      console.log(`📍 API статуса: GET http://localhost:${PORT}/api/task/:taskId`);
      console.log(`🔍 API upscale: POST http://localhost:${PORT}/api/upscale`);
      console.log(`✨ API полной генерации: POST http://localhost:${PORT}/api/generate-full`);
      console.log(`🌍 Среда: ${process.env.NODE_ENV || 'development'}`);
    });
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM signal received: closing HTTP server');
      server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      console.log('SIGINT signal received: closing HTTP server');
      server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
      });
    });
    
  } catch (error) {
    console.error('❌ Ошибка запуска сервера:', error);
    process.exit(1);
  }
}

// Запускаем
start();
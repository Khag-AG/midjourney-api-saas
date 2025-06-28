// test-local.js - Локальное тестирование генерации и upscale
require('dotenv').config();

// Конфигурация
const API_URL = 'http://localhost:3000'; // Локальный сервер
const API_KEY = 'mj_p448uim99tp8lxef93lja5'; // Замените на ваш API ключ

// Функция для задержки
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 1. Функция генерации изображения
async function generateImage(prompt) {
  console.log('\n🎨 Запускаем генерацию изображения...');
  console.log(`Prompt: ${prompt}`);
  
  try {
    const response = await fetch(`${API_URL}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({ prompt })
    });
    
    const data = await response.json();
    console.log('📥 Ответ от сервера:', data);
    
    if (!data.success || !data.task_id) {
      throw new Error('Не удалось запустить генерацию');
    }
    
    return data.task_id;
  } catch (error) {
    console.error('❌ Ошибка генерации:', error.message);
    throw error;
  }
}

// 2. Функция проверки статуса генерации
async function checkStatus(taskId) {
  console.log(`\n🔍 Проверяем статус задачи ${taskId}...`);
  
  try {
    const response = await fetch(`${API_URL}/api/task/${taskId}`, {
      method: 'GET',
      headers: {
        'X-API-Key': API_KEY
      }
    });
    
    const data = await response.json();
    console.log('📊 Статус:', data.status);
    if (data.progress) console.log('📈 Прогресс:', data.progress + '%');
    
    return data;
  } catch (error) {
    console.error('❌ Ошибка проверки статуса:', error.message);
    throw error;
  }
}

// 3. Функция upscale изображения
async function upscaleImage(taskId, index) {
  console.log(`\n🔍 Запускаем upscale...`);
  console.log(`Task ID: ${taskId}`);
  console.log(`Index: ${index}`);
  
  try {
    const response = await fetch(`${API_URL}/api/upscale`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({
        task_id: taskId,
        index: index
      })
    });
    
    console.log('📊 Статус ответа:', response.status);
    
    const contentType = response.headers.get('content-type');
    console.log('📄 Content-Type:', contentType);
    
    if (!response.ok) {
      const text = await response.text();
      console.log('❌ Ошибка сервера:', text.substring(0, 200) + '...');
      throw new Error(`Server error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('📥 Ответ upscale:', data);
    
    return data;
  } catch (error) {
    console.error('❌ Ошибка upscale:', error.message);
    throw error;
  }
}

// Главная функция тестирования
async function runTest() {
  console.log('🚀 Начинаем тестирование Midjourney API...\n');
  
  try {
    // 1. Генерируем изображение
    const prompt = 'Beautiful sunset over mountains, photorealistic, 8k';
    const taskId = await generateImage(prompt);
    
    // 2. Ждем завершения генерации
    let status;
    let attempts = 0;
    const maxAttempts = 60; // 2 минуты максимум
    
    do {
      await delay(2000); // Проверяем каждые 2 секунды
      status = await checkStatus(taskId);
      attempts++;
      
      if (attempts >= maxAttempts) {
        throw new Error('Превышено время ожидания генерации');
      }
    } while (status.status === 'processing');
    
    if (status.status !== 'completed') {
      throw new Error(`Генерация завершилась с ошибкой: ${status.error}`);
    }
    
    console.log('\n✅ Генерация завершена!');
    console.log(`🖼️  URL изображения: ${status.image_url}`);
    console.log(`🆔 Midjourney ID: ${status.midjourney_id}`);
    
    // 3. Ждем немного перед upscale
    console.log('\n⏳ Ждем 5 секунд перед upscale...');
    await delay(5000);
    
    // 4. Делаем upscale для каждой из 4 картинок
    console.log('\n🚀 Тестируем upscale для всех 4 изображений...\n');
    
    for (let index = 1; index <= 4; index++) {
      console.log(`\n--- Upscale изображения #${index} ---`);
      
      try {
        const upscaleResult = await upscaleImage(status.midjourney_id, index);
        
        if (upscaleResult.success) {
          console.log(`✅ Upscale #${index} успешен!`);
          console.log(`🖼️  URL: ${upscaleResult.image_url}`);
        } else {
          console.log(`❌ Upscale #${index} неудачен:`, upscaleResult.error);
        }
      } catch (error) {
        console.log(`❌ Ошибка при upscale #${index}:`, error.message);
      }
      
      // Задержка между upscale
      if (index < 4) {
        console.log('\n⏳ Ждем 3 секунды...');
        await delay(3000);
      }
    }
    
    console.log('\n\n✅ Тестирование завершено!');
    
  } catch (error) {
    console.error('\n❌ Критическая ошибка:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Запускаем тест
runTest();
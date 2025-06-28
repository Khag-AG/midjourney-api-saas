const fs = require('fs').promises;
const path = require('path');
const { initDatabase, users, history, fullGenerations } = require('./database');

// Путь к директории с данными
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');

async function loadFileDB(filename) {
  try {
    const filepath = path.join(DATA_DIR, filename);
    const content = await fs.readFile(filepath, 'utf8');
    const parsed = JSON.parse(content);
    return new Map(parsed);
  } catch (error) {
    console.log(`⚠️ Файл ${filename} не найден или пуст`);
    return new Map();
  }
}

async function migrateData() {
  console.log('🔄 Начинаем миграцию данных в PostgreSQL...');
  console.log(`📁 Директория данных: ${DATA_DIR}`);
  
  // Инициализируем таблицы
  await initDatabase();
  
  try {
    // 1. Миграция пользователей
    console.log('\n📋 Миграция пользователей...');
    const usersData = await loadFileDB('users.json');
    
    if (usersData.size > 0) {
      console.log(`  Найдено ${usersData.size} пользователей`);
      
      for (const [apiKey, userData] of usersData.entries()) {
        try {
          // Проверяем, существует ли уже пользователь
          const existing = await users.getByApiKey(apiKey);
          
          if (!existing) {
            await users.create({
              api_key: apiKey,
              username: userData.userEmail || userData.username || 'Unknown',
              server_id: userData.serverId || userData.server_id,
              channel_id: userData.channelId || userData.channel_id,
              salai_token: userData.salaiToken || userData.salai_token,
              monthly_limit: userData.monthlyLimit || userData.monthly_limit || 1000,
              is_admin: userData.role === 'admin' || userData.is_admin || false
            });
            
            // Если пользователь заблокирован
            if (userData.status === 'blocked' || userData.is_blocked) {
              await users.setBlocked(apiKey, true);
            }
            
            console.log(`  ✅ Мигрирован: ${userData.userEmail || userData.username}`);
          } else {
            console.log(`  ⏭️  Уже существует: ${userData.userEmail || userData.username}`);
          }
        } catch (error) {
          console.error(`  ❌ Ошибка миграции пользователя:`, error.message);
        }
      }
    } else {
      console.log('  Пользователи не найдены');
    }
    
    // 2. Миграция счетчиков использования
    console.log('\n📊 Миграция счетчиков использования...');
    const usageData = await loadFileDB('usage.json');
    
    if (usageData.size > 0) {
      console.log(`  Найдено ${usageData.size} записей использования`);
      
      for (const [apiKey, usage] of usageData.entries()) {
        try {
          // Обновляем счетчики для существующих пользователей
          const user = await users.getByApiKey(apiKey);
          if (user) {
            // Устанавливаем счетчик использования
            for (let i = 0; i < (usage.count || 0); i++) {
              await users.incrementUsage(apiKey);
            }
            console.log(`  ✅ Обновлен счетчик для ${apiKey}: ${usage.count}`);
          }
        } catch (error) {
          console.error(`  ❌ Ошибка обновления счетчика:`, error.message);
        }
      }
    } else {
      console.log('  Данные использования не найдены');
    }
    
    // 3. Миграция истории генераций
    console.log('\n📜 Миграция истории генераций...');
    const historyData = await loadFileDB('history.json');
    
    if (historyData.size > 0) {
      let totalHistoryRecords = 0;
      
      for (const [apiKey, userHistory] of historyData.entries()) {
        if (Array.isArray(userHistory)) {
          totalHistoryRecords += userHistory.length;
          
          for (const record of userHistory) {
            try {
              await history.add(
                apiKey,
                record.prompt || '',
                JSON.stringify({
                  imageUrl: record.imageUrl || record.image_url,
                  taskId: record.taskId || record.task_id,
                  hash: record.hash,
                  timestamp: record.timestamp
                }),
                'completed'
              );
            } catch (error) {
              console.error(`  ❌ Ошибка миграции записи истории:`, error.message);
            }
          }
        }
      }
      
      console.log(`  ✅ Мигрировано ${totalHistoryRecords} записей истории`);
    } else {
      console.log('  История не найдена');
    }
    
    // 4. Миграция полных генераций
    console.log('\n🎨 Миграция полных генераций...');
    const fullGenData = await loadFileDB('full_generations.json');
    
    if (fullGenData.size > 0) {
      console.log(`  Найдено ${fullGenData.size} полных генераций`);
      
      for (const [id, generation] of fullGenData.entries()) {
        try {
          await fullGenerations.create(id, generation);
          console.log(`  ✅ Мигрирована полная генерация: ${id}`);
        } catch (error) {
          console.error(`  ❌ Ошибка миграции полной генерации:`, error.message);
        }
      }
    } else {
      console.log('  Полные генерации не найдены');
    }
    
    // 5. Создание резервной копии
    console.log('\n💾 Создание резервной копии...');
    const backupDir = path.join(__dirname, 'data_backup_' + new Date().toISOString().split('T')[0]);
    
    try {
      await fs.mkdir(backupDir, { recursive: true });
      
      const files = ['users.json', 'usage.json', 'history.json', 'full_generations.json'];
      
      for (const file of files) {
        try {
          const sourcePath = path.join(DATA_DIR, file);
          const destPath = path.join(backupDir, file);
          await fs.copyFile(sourcePath, destPath);
          console.log(`  ✅ Скопирован: ${file}`);
        } catch (error) {
          console.log(`  ⏭️  Файл ${file} не найден`);
        }
      }
      
      console.log(`\n📁 Резервная копия создана в: ${backupDir}`);
    } catch (error) {
      console.error('❌ Ошибка создания резервной копии:', error);
    }
    
    // 6. Финальная статистика
    const totalUsers = await users.count();
    const stats = await users.getStats();
    
    console.log('\n✨ Миграция завершена успешно!');
    console.log('\n📊 Статистика:');
    console.log(`  Всего пользователей: ${totalUsers}`);
    console.log(`  Активных: ${stats.activeusers}`);
    console.log(`  Заблокированных: ${stats.blockedusers}`);
    console.log(`  Администраторов: ${stats.adminusers}`);
    
  } catch (error) {
    console.error('\n❌ Критическая ошибка миграции:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

// Проверяем наличие DATABASE_URL
if (!process.env.DATABASE_URL) {
  console.error('❌ Ошибка: переменная DATABASE_URL не установлена');
  console.error('   Добавьте DATABASE_URL в переменные окружения Railway');
  process.exit(1);
}

// Запускаем миграцию
migrateData();
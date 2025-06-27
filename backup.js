const fs = require('fs').promises;
const path = require('path');

// Функция для создания бэкапа
async function createBackup() {
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const backupDir = path.join(__dirname, 'backups');
  
  try {
    // Создаем папку для бэкапов
    await fs.mkdir(backupDir, { recursive: true });
    
    // Копируем файлы
    const files = ['users.json', 'usage.json', 'history.json', 'full_generations.json'];
    
    for (const file of files) {
      const sourcePath = path.join(__dirname, 'data', file);
      const destPath = path.join(backupDir, `${timestamp}_${file}`);
      
      try {
        await fs.copyFile(sourcePath, destPath);
        console.log(`✅ Бэкап создан: ${file}`);
      } catch (error) {
        console.log(`⚠️ Файл не найден: ${file}`);
      }
    }
    
    console.log('📦 Бэкап завершен!');
  } catch (error) {
    console.error('❌ Ошибка создания бэкапа:', error);
  }
}

createBackup();
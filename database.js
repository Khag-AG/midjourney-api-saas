const { Pool } = require('pg');

// Подключение к БД через переменную окружения Railway
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Инициализация таблиц при первом запуске
async function initDatabase() {
  try {
    // Создаем таблицу пользователей
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        api_key VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(255) NOT NULL,
        monthly_limit INTEGER DEFAULT 1000,
        usage_count INTEGER DEFAULT 0,
        is_admin BOOLEAN DEFAULT false,
        is_blocked BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reset_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        server_id VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        salai_token TEXT NOT NULL
      )
    `);

    // Создаем таблицу истории генераций
    await pool.query(`
      CREATE TABLE IF NOT EXISTS generation_history (
        id SERIAL PRIMARY KEY,
        api_key VARCHAR(255) NOT NULL,
        prompt TEXT NOT NULL,
        result TEXT,
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (api_key) REFERENCES users(api_key) ON DELETE CASCADE
      )
    `);

    // Создаем таблицу полных генераций
    await pool.query(`
      CREATE TABLE IF NOT EXISTS full_generations (
        id VARCHAR(255) PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing database:', error);
  }
}

// Функции для работы с пользователями
const users = {
  // Получить всех пользователей
  async getAll() {
    const result = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    return result.rows;
  },

  // Получить пользователя по API ключу
  async getByApiKey(apiKey) {
    const result = await pool.query('SELECT * FROM users WHERE api_key = $1', [apiKey]);
    return result.rows[0];
  },

  // Создать нового пользователя
  async create(userData) {
    const { api_key, username, server_id, channel_id, salai_token, monthly_limit = 1000, is_admin = false } = userData;
    const result = await pool.query(
      `INSERT INTO users (api_key, username, server_id, channel_id, salai_token, monthly_limit, is_admin) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING *`,
      [api_key, username, server_id, channel_id, salai_token, monthly_limit, is_admin]
    );
    return result.rows[0];
  },

  // Обновить счетчик использования
  async incrementUsage(apiKey) {
    const result = await pool.query(
      `UPDATE users 
       SET usage_count = usage_count + 1 
       WHERE api_key = $1 
       RETURNING *`,
      [apiKey]
    );
    return result.rows[0];
  },

  // Сбросить месячные счетчики (запускать по расписанию)
  async resetMonthlyUsage() {
    await pool.query(
      `UPDATE users 
       SET usage_count = 0, reset_date = CURRENT_TIMESTAMP 
       WHERE DATE_PART('month', reset_date) != DATE_PART('month', CURRENT_DATE)`
    );
  },

  // Заблокировать/разблокировать пользователя
  async setBlocked(apiKey, isBlocked) {
    const result = await pool.query(
      'UPDATE users SET is_blocked = $1 WHERE api_key = $2 RETURNING *',
      [isBlocked, apiKey]
    );
    return result.rows[0];
  },

  // Удалить пользователя
  async delete(apiKey) {
    await pool.query('DELETE FROM users WHERE api_key = $1', [apiKey]);
  },

  // Обновить лимит пользователя
  async updateLimit(apiKey, newLimit) {
    const result = await pool.query(
      'UPDATE users SET monthly_limit = $1 WHERE api_key = $2 RETURNING *',
      [newLimit, apiKey]
    );
    return result.rows[0];
  },

  // Получить количество пользователей
  async count() {
    const result = await pool.query('SELECT COUNT(*) FROM users');
    return parseInt(result.rows[0].count);
  },

  // Получить статистику пользователей
  async getStats() {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE is_blocked = false) as activeUsers,
        COUNT(*) FILTER (WHERE is_blocked = true) as blockedUsers,
        COUNT(*) FILTER (WHERE is_admin = true) as adminUsers
      FROM users
    `);
    return result.rows[0];
  },

  // Сбросить использование для конкретного пользователя
  async resetUsage(apiKey) {
    const result = await pool.query(
      'UPDATE users SET usage_count = 0, reset_date = CURRENT_TIMESTAMP WHERE api_key = $1 RETURNING *',
      [apiKey]
    );
    return result.rows[0];
  }
};

// Функции для работы с историей
const history = {
  // Добавить запись в историю
  async add(apiKey, prompt, result, status = 'completed') {
    const res = await pool.query(
      `INSERT INTO generation_history (api_key, prompt, result, status) 
       VALUES ($1, $2, $3, $4) 
       RETURNING *`,
      [apiKey, prompt, result, status]
    );
    return res.rows[0];
  },

  // Получить историю пользователя
  async getByUser(apiKey, limit = 50) {
    const result = await pool.query(
      'SELECT * FROM generation_history WHERE api_key = $1 ORDER BY created_at DESC LIMIT $2',
      [apiKey, limit]
    );
    return result.rows;
  },

  // Получить всю историю (для админов)
  async getAll(limit = 100) {
    const result = await pool.query(
      `SELECT h.*, u.username 
       FROM generation_history h 
       JOIN users u ON h.api_key = u.api_key 
       ORDER BY h.created_at DESC 
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  },

  // Получить статистику
  async getStats() {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_generations,
        COUNT(DISTINCT api_key) as unique_users,
        DATE(created_at) as date
      FROM generation_history
      WHERE created_at > CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);
    return result.rows;
  }
};

// Функции для работы с полными генерациями
const fullGenerations = {
  // Создать новую полную генерацию
  async create(id, data) {
    const result = await pool.query(
      `INSERT INTO full_generations (id, data) VALUES ($1, $2) RETURNING *`,
      [id, JSON.stringify(data)]
    );
    return result.rows[0];
  },

  // Получить полную генерацию по ID
  async get(id) {
    const result = await pool.query(
      'SELECT * FROM full_generations WHERE id = $1',
      [id]
    );
    return result.rows[0] ? JSON.parse(result.rows[0].data) : null;
  },

  // Обновить полную генерацию
  async update(id, data) {
    const result = await pool.query(
      'UPDATE full_generations SET data = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [JSON.stringify(data), id]
    );
    return result.rows[0];
  },

  // Обновить прогресс генерации
  async updateProgress(id, progress) {
    const generation = await this.get(id);
    if (generation) {
      generation.progress = progress;
      await this.update(id, generation);
    }
  },

  // Получить генерации пользователя
  async getByUser(apiKey) {
    const result = await pool.query(
      `SELECT * FROM full_generations 
       WHERE data->>'apiKey' = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [apiKey]
    );
    
    return result.rows.map(row => {
      const data = JSON.parse(row.data);
      return {
        full_generation_id: data.id,
        prompt: data.prompt,
        status: data.status,
        total_images: data.stats?.total_images || 0,
        created_at: data.startedAt,
        completed_at: data.completedAt
      };
    });
  },

  // Получить все генерации (для админов)
  async getAll(limit = 100) {
    const result = await pool.query(
      `SELECT * FROM full_generations 
       ORDER BY created_at DESC 
       LIMIT $1`,
      [limit]
    );
    
    return result.rows.map(row => {
      const data = JSON.parse(row.data);
      return {
        full_generation_id: data.id,
        user: data.username,
        prompt: data.prompt,
        status: data.status,
        total_images: data.stats?.total_images || 0,
        successful_upscales: data.stats?.successful_upscales || 0,
        duration_seconds: data.stats?.duration_seconds || 0,
        created_at: data.startedAt,
        completed_at: data.completedAt
      };
    });
  }
};

// Экспортируем функции
module.exports = {
  initDatabase,
  users,
  history,
  fullGenerations,
  pool // на случай если понадобятся прямые запросы
};
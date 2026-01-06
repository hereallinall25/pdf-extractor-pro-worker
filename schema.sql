-- Create extraction prompts table if it doesn't exist
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  university TEXT,
  state TEXT,
  type TEXT,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create chat assistant prompts table if it doesn't exist
CREATE TABLE IF NOT EXISTS chat_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create usage logs table for analytics
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'extraction' or 'chat'
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  token_total INTEGER DEFAULT 0,
  file_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

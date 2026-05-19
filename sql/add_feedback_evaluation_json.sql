ALTER TABLE feedbacks
ADD COLUMN IF NOT EXISTS evaluation_json JSONB;

-- Conversation state: chat_state can now wait for the next turn of a conversation ('chat').
-- Apply: podman exec -i n8n_postgres_1 psql -U n8n -d n8n -v ON_ERROR_STOP=1 < migrations/002_chat.sql
BEGIN;
ALTER TABLE brain.chat_state DROP CONSTRAINT chat_state_awaiting_check;
ALTER TABLE brain.chat_state ADD CONSTRAINT chat_state_awaiting_check CHECK (awaiting IN ('edit_batch','other_date','chat'));
COMMIT;

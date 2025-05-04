CREATE TABLE blocks (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    parent_block_id UUID,
    order_in_parent INTEGER NOT NULL DEFAULT 0,
    type VARCHAR(50) NOT NULL,
    properties JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for search by workspace_id
CREATE INDEX idx_blocks_workspace_id ON blocks(workspace_id);

-- Index for search by parent_block_id
CREATE INDEX idx_blocks_parent_order ON blocks(parent_block_id, order_in_parent);

-- Index for search by type
CREATE INDEX idx_blocks_text_search ON blocks USING GIN ((properties->>'text') gin_trgm_ops);

-- Function to update updated_at field on row update
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to call the function before updating a row
CREATE TRIGGER update_blocks_updated_at
BEFORE UPDATE ON blocks
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- Table for storing block types
CREATE TABLE shard_info (
    shard_name VARCHAR(50) PRIMARY KEY,
    description TEXT
);

-- Insert initial shard information
INSERT INTO shard_info (shard_name, description) 
VALUES ('shard_placeholder', 'This is shard placeholder');
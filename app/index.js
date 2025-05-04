const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

const SHARD_COUNT = 3;


const pgbouncerPoolsByShard = {};
const pgbouncerHosts = ['pgbouncer1', 'pgbouncer2'];
let poolsInitialized = false; 


function getShardNumber(workspaceId) {
    if (!workspaceId || typeof workspaceId !== 'string' || workspaceId.length < 10) {
        throw new Error(`Invalid workspaceId for sharding: ${workspaceId}`);
    }
    const hexPart = workspaceId.replace(/-/g, '').substring(0, 8);
    const workspaceIdNum = parseInt(hexPart, 16);
    if (isNaN(workspaceIdNum)) {
        throw new Error(`Could not parse workspaceId for sharding: ${workspaceId}`);
    }
    if (isNaN(SHARD_COUNT) || SHARD_COUNT <= 0) {
        throw new Error("Internal server configuration error: Invalid SHARD_COUNT");
    }
    return workspaceIdNum % SHARD_COUNT;
}

function getPoolForWorkspace(workspaceId) {
  const shardNumber = getShardNumber(workspaceId);
  const logicalDbName = `shard${shardNumber}`;

  if (!pgbouncerPoolsByShard[logicalDbName]) {
      if (!poolsInitialized) {
          console.log(`Lazy initializing connection pools via ${pgbouncerHosts.length} PgBouncer instances...`);
          poolsInitialized = true; // Ставим флаг
      }

      const pgbouncerUser = process.env.PGBOUNCER_USER || 'postgres';
      const pgbouncerPassword = process.env.PGBOUNCER_PASSWORD || 'postgres';
      const pgbouncerHost = pgbouncerHosts[shardNumber % pgbouncerHosts.length];

      console.log(`Creating pool for ${logicalDbName} via ${pgbouncerHost}`);

      pgbouncerPoolsByShard[logicalDbName] = new Pool({
          host: pgbouncerHost,
          port: 6432,
          database: logicalDbName, 
          user: pgbouncerUser,
          password: pgbouncerPassword,
          max: 15, 
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000, 
      });

      // Error handling for the pool
      pgbouncerPoolsByShard[logicalDbName].on('error', (err, client) => {
            console.error(`[Shard Pool ${logicalDbName}] Unexpected error on idle client`, err);
      });
      console.log(`Pool for ${logicalDbName} created.`);
  }

  const pool = pgbouncerPoolsByShard[logicalDbName];

  if (!pool) {
      console.error(`FATAL: Pool for logical database ${logicalDbName} could not be created or retrieved!`);
      throw new Error(`Internal server configuration error: Pool for ${logicalDbName} missing.`);
  }

  console.log(`Routing workspace ${workspaceId} -> using pool for ${logicalDbName} (connected via ${pool.options.host})`);

  return { pool, shardNumber, logicalDbName };
}

app.post('/api/blocks', async (req, res) => {
  const { workspaceId, parentBlockId, type, properties } = req.body;
  const blockId = uuidv4();

  try {
    const { pool, shardNumber, logicalDbName } = getPoolForWorkspace(workspaceId);

    const client = await pool.connect(); 
    try {
      const result = await client.query({
          text: `INSERT INTO blocks (id, workspace_id, parent_block_id, type, properties)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
          values: [blockId, workspaceId, parentBlockId || null, type || 'text', properties || {}]
      });

      const shardInfo = await client.query({ text: 'SELECT * FROM shard_info' }); 

      res.status(201).send({
        block: result.rows[0],
        routing: {
          workspaceId,
          shardNumber,
          pgBouncerHost: pool.options.host,
          logicalDatabase: pool.options.database, 
          shardInfo: shardInfo.rows[0]
        }
      });
    } finally {
      client.release();
    }
  } catch (err) {
     console.error(`Error creating block for workspace ${workspaceId}:`, err.message);
     if (err.message.includes("Invalid workspaceId") || err.message.includes("Could not parse workspaceId")) {
       res.status(400).send({ error: 'Invalid workspaceId provided', details: err.message });
     } else {
       res.status(500).send({ error: 'Failed to create block', details: err.message });
     }
  }
});

app.put('/api/blocks/:id', async (req, res) => {
  const { id } = req.params;
  const { workspaceId, properties } = req.body;

  try {
    const { pool, shardNumber, logicalDbName } = getPoolForWorkspace(workspaceId);

    const client = await pool.connect();
    try {
      const result = await client.query({
          text: `UPDATE blocks
                 SET properties = $1, updated_at = NOW()
                 WHERE id = $2 AND workspace_id = $3
                 RETURNING *`,
          values: [properties, id, workspaceId]
      });

      if (result.rows.length === 0) {
         const check = await client.query({text: 'SELECT id FROM blocks WHERE id = $1', values: [id]  }); 
         if (check.rows.length > 0) {
             return res.status(400).send({ error: `Block ${id} found, but does not belong to workspace ${workspaceId} on shard ${shardNumber}` });
         } else {
             return res.status(404).send({ error: `Block ${id} not found on shard ${shardNumber}` });
         }
      }

      const shardInfo = await client.query({ text: 'SELECT * FROM shard_info'  }); 

      res.send({
        block: result.rows[0],
        routing: {
          workspaceId,
          shardNumber,
          pgBouncerHost: pool.options.host,
          logicalDatabase: pool.options.database,
          shardInfo: shardInfo.rows[0]
        }
      });
    } finally {
      client.release();
    }
  } catch (err) {
     console.error(`Error updating block ${id} for workspace ${workspaceId}:`, err.message);
     if (err.message.includes("Invalid workspaceId") || err.message.includes("Could not parse workspaceId")) {
       res.status(400).send({ error: 'Invalid workspaceId provided', details: err.message });
     } else {
       res.status(500).send({ error: 'Failed to update block', details: err.message });
     }
  }
});


app.get('/api/workspaces/:workspaceId/blocks', async (req, res) => {
  const { workspaceId } = req.params;

  try {
    const { pool, shardNumber, logicalDbName } = getPoolForWorkspace(workspaceId);

    const client = await pool.connect();
    try {
      const result = await client.query({
        text: `SELECT * FROM blocks WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`,
        values: [workspaceId]
      });

      const shardInfo = await client.query({ text: 'SELECT * FROM shard_info' }); 

      res.send({
        blocks: result.rows,
        routing: {
          workspaceId,
          shardNumber,
          pgBouncerHost: pool.options.host,
          logicalDatabase: pool.options.database,
          shardInfo: shardInfo.rows[0]
        }
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`Error fetching blocks for workspace ${workspaceId}:`, err.message);
    if (err.message.includes("Invalid workspaceId") || err.message.includes("Could not parse workspaceId")) {
       res.status(400).send({ error: 'Invalid workspaceId provided', details: err.message });
    } else {
       res.status(500).send({ error: 'Failed to fetch blocks', details: err.message });
    }
  }
});


app.get('/api/generate-workspaces', (req, res) => {
    console.log("Received /api/generate-workspaces request"); 
    const count = parseInt(req.query.count) || 10;
    const workspaces = [];
    console.log(`Generating ${count} workspaces...`);
  
    for (let i = 0; i < count; i++) {
      const workspaceId = uuidv4();
      try {
          const shardNumber = getShardNumber(workspaceId); 
          workspaces.push({ workspaceId, shardNumber });
      } catch (e) {
          console.error("Error generating shard number for new UUID:", e.message);
      }
    }
    console.log("Generated workspace data");
  
    const distribution = {};
    for (let i = 0; i < SHARD_COUNT; i++) {
      distribution[`shard${i}`] = workspaces.filter(w => w.shardNumber === i).length;
    }
    console.log("Calculated distribution");
  
    res.send({ workspaces, distribution });
    console.log("Response sent for /api/generate-workspaces"); 
  });
  
  
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
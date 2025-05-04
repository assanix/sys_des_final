# PostgreSQL Sharding Demo for Notion-like System

## 1. Overview

This project demonstrates a core architectural pattern for scaling a data-intensive application like Notion: application-level database sharding with PostgreSQL and PgBouncer.

It simulates a backend system where data (specifically "blocks" belonging to different "workspaces") is distributed across multiple PostgreSQL database shards based on the `workspace_id`. A Node.js/Express API acts as the "Core Service", handling incoming requests, determining the correct shard for a given `workspaceId`, and interacting with the database through a PgBouncer connection pool.

**Goal:** To provide a runnable Proof of Concept (PoC) validating the database sharding strategy described in the main system design document, showcasing data isolation and request routing.

**Key Components:**

*   **Node.js/Express App (`app`):** A simple API server with endpoints to create, update, and read blocks. Contains the sharding logic.
*   **PostgreSQL Shards (`postgres-shard0`, `postgres-shard1`, `postgres-shard2`):** Three independent PostgreSQL containers representing physical database shards.
*   **PgBouncer Instances (`pgbouncer1`, `pgbouncer2`):** Two PgBouncer containers managing connection pools to the PostgreSQL shards. The Node.js app connects to these.
*   **Docker Compose:** Orchestrates the startup and networking of all containers.

## 2. Project Structure

```
/notion-sharding-demo
├── app/ # Node.js/Express API service \n
│ ├── Dockerfile # Docker build instructions for the app
│ ├── index.js # Main API and sharding logic
│ ├── package.json # Node.js dependencies
│ └── package-lock.json # Lockfile for dependencies
├── db/ # Database initialization scripts
│ ├── extensions.sql # Script to enable required PostgreSQL extensions
│ └── init.sql # Script to create the 'blocks' and 'shard_info' tables
├── pgbouncer/ # PgBouncer configuration files
│ ├── pgbouncer1.ini # Configuration for the first PgBouncer instance
│ ├── pgbouncer2.ini # Configuration for the second PgBouncer instance
│ └── userlist.txt # Authentication file for PgBouncer
├── docker-compose.yml # Docker Compose file to run the entire stack
└── README.md # This file
```
## 3. Prerequisites

*   Docker: [Install Docker](https://docs.docker.com/get-docker/)
*   Docker Compose: Usually included with Docker Desktop or installed separately ([Install Docker Compose](https://docs.docker.com/compose/install/)).
*   Node.js & npm: Optional, only if you need to modify `app` dependencies locally ([Install Node.js](https://nodejs.org/)).
*   `curl` or a similar tool (like Postman or Insomnia) to make HTTP requests to the API.

## 4. Setup & Running

1.  **Clone the repository (if applicable) or ensure you have all the files** listed in the Project Structure section.
2.  **(Optional) Install Node.js dependencies:** If you plan to modify the `app` code, navigate to the `app/` directory and run:
    ```
    cd app
    npm install
    cd ..
    ```
3.  **(Note on `.env` file):** This project uses default credentials (`postgres`/`postgres`) directly in the configuration files (`docker-compose.yml`, `pgbouncer/*.ini`, `app/index.js`) for simplicity in this demonstration environment. Therefore, a `.env` file is **not required** to run this demo. In a production system, credentials must be managed securely using environment variables sourced from a proper secrets management system.
4.  **Build and Start Containers:** Open a terminal in the root directory of the project (`notion-sharding-demo/`) and run:
    ```bash
    # Stop and remove any previous containers/volumes (for a clean start)
    docker-compose down -v

    # Build the app image and start all services in detached mode
    docker-compose up --build -d
    ```

5.  **Verify Status:** Wait for 15-20 seconds for everything to initialize, then check the status of the containers:
    ```
    docker-compose ps
    ```
    You should see all 6 services (`postgres-shard0`, `postgres-shard1`, `postgres-shard2`, `pgbouncer1`, `pgbouncer2`, `notion_app_guide`) listed with a status of `Up` or `running`. PostgreSQL services should also show `(healthy)`.

## 5. Testing the API and Sharding Logic

Use `curl` or another API client to send requests to `http://localhost:3000`.

### Step 1: Generate Workspace IDs

Get some sample `workspaceId`s and see their predicted shard distribution.

```bash
curl "http://localhost:3000/api/generate-workspaces?count=5"
```
```

Example Response:

{
    "workspaces": [
        {"workspaceId": "84f2811a-bc65-4639-b7d3-9bef7352f5a6", "shardNumber": 1},
        {"workspaceId": "9b35ccca-0f55-45b2-8af5-a999ceea3410", "shardNumber": 2},
        {"workspaceId": "c6772c77-4046-47bf-a089-4262b2505911", "shardNumber": 0},
        /* ... more IDs ... */
    ],
    "distribution": { /* ... */ }
}
```

Action: Note down a workspaceId for each shardNumber (e.g., WS_ID_0 = c677..., WS_ID_1 = 84f2..., WS_ID_2 = 9b35...).

### Step 2: Create Blocks on Different Shards

Create blocks using the IDs noted above. Pay attention to the routing section in the response.
```
# Create on Shard 0 (Use WS_ID_0)
curl -X POST http://localhost:3000/api/blocks \
  -H "Content-Type: application/json" \
  -d '{"workspaceId": "c6772c77-4046-47bf-a089-4262b2505911", "type": "text", "properties": {"text": "Data for Shard 0"}}'

# Create on Shard 1 (Use WS_ID_1)
curl -X POST http://localhost:3000/api/blocks \
  -H "Content-Type: application/json" \
  -d '{"workspaceId": "84f2811a-bc65-4639-b7d3-9bef7352f5a6", "type": "heading", "properties": {"text": "Заголовок в шарде 1"}}'

# Create on Shard 2 (Use WS_ID_2)
curl -X POST http://localhost:3000/api/blocks \
  -H "Content-Type: application/json" \
  -d '{"workspaceId": "9b35ccca-0f55-45b2-8af5-a999ceea3410", "type": "text", "properties": {"text": "Data for Shard 2"}}'
```

Example Response (for Shard 1):
```
{
    "block": {
        "id": "bdee81e7-46d7-4fd2-b8fd-6826b6089648", // Note this block ID
        "workspace_id": "84f2811a-bc65-4639-b7d3-9bef7352f5a6",
        // ... other block fields ...
    },
    "routing": {
        "workspaceId": "84f2811a-bc65-4639-b7d3-9bef7352f5a6",
        "shardNumber": 1,                     // Correct shard number
        "pgBouncerHost": "pgbouncer2",         // Correct PgBouncer instance
        "logicalDatabase": "shard1",          // Correct logical DB name used by app pool
        "shardInfo": {                        // Info fetched from the actual DB shard
            "shard_name": "shard1",
            "description": "This is shard 1"
        }
    }
}
```

Verification: Check that shardNumber and shardInfo.shard_name match the expected shard for the given workspaceId. Note the id of the created blocks.

### Step 3: Read Blocks and Verify Isolation

Fetch blocks for each workspace individually.
```
# Read from Shard 0
curl "http://localhost:3000/api/workspaces/c6772c77-4046-47bf-a089-4262b2505911/blocks"

# Read from Shard 1
curl "http://localhost:3000/api/workspaces/84f2811a-bc65-4639-b7d3-9bef7352f5a6/blocks"

# Read from Shard 2
curl "http://localhost:3000/api/workspaces/9b35ccca-0f55-45b2-8af5-a999ceea3410/blocks"
```

Verification: Each request should return only the blocks created for that specific workspaceId and confirm routing to the correct shard via the routing object.

### Step 4: Update a Block

Update one of the blocks created earlier (e.g., the one on Shard 1). Use the actual blockId from the POST response.
```
# Replace BLOCK_ID_SHARD_1 with the actual ID (e.g., bdee81e7-...)
# Replace WS_ID_SHARD_1 with the actual ID (e.g., 84f2811a-...)
curl -X PUT http://localhost:3000/api/blocks/BLOCK_ID_SHARD_1 \
  -H "Content-Type: application/json" \
  -d '{"workspaceId": "WS_ID_SHARD_1", "properties": {"text": "Обновленный Заголовок в шарде 1"}}'

```
Verification: Check the updated properties and confirm routing to the correct shard (Shard 1 in this example).

## 6. Key Learnings & Proof of Concept Validation

- This implementation successfully demonstrates the core concepts of the designed data storage architecture:

- Application-Level Sharding: The Node.js application correctly calculates the target shard based on workspace_id using a hashing function.

- Request Routing: API requests are directed to the appropriate database shard. The routing information in the API responses, including shardInfo fetched directly from the target database, confirms this.

- Data Isolation: Retrieving data for a specific workspaceId only returns records residing on the designated shard, proving that data belonging to different workspaces is effectively isolated.

- Connection Pooling (PgBouncer): The application connects through PgBouncer instances, which manage the underlying connections to the PostgreSQL shards. This is crucial for handling a large number of application connections efficiently without overloading the databases. Logs show PgBouncer handling login attempts and establishing connections to the backend databases.

- Foundation for Scalability: This setup validates the fundamental mechanism for horizontally scaling the database layer. By adding more physical PostgreSQL nodes and updating the PgBouncer configuration ([databases] section) and potentially the SHARD_COUNT/hashing logic in the application, the system can accommodate significant data growth, aligning with the non-functional requirements.

- Consistency: By ensuring all operations for a given workspaceId land on the same shard, strong consistency within a workspace (a key requirement) is maintained via standard PostgreSQL ACID transactions on that shard.

- Limitations: This PoC does not implement features like replication, failover, automated re-sharding, authentication, or the full block model, but it successfully validates the core data partitioning and access strategy.

## 7. Differences from Initial Design & Debugging Journey

During the implementation and debugging of this PoC, several adjustments and discoveries were made compared to the initial theoretical approach or potential pitfalls:

- PgBouncer entrypoint: The initial assumption was that the standard pgbouncer/pgbouncer:latest image could be run by simply providing the configuration file path in the command. However, logs revealed that the image's default entrypoint script required specific environment variables (```DATABASES_HOST``` or ```DATABASES```) which were not suitable for our sharded setup defined entirely in .ini files.

  Change: The entrypoint in docker-compose.yml was explicitly overridden to point directly to the pgbouncer executable (```/opt/pgbouncer/pgbouncer```), and the necessary arguments (```-u postgres and the config file path```) were provided via command. This bypasses the problematic entrypoint script.

- PgBouncer user: The attempt to run PgBouncer as a non-default user (```user: pgbouncer```) failed because that user doesn't exist in the official image.

  Change: The user: pgbouncer directive was removed, and the process is now explicitly run as postgres using the ```-u postgres``` flag in the command.

- Node.js pg Pool Initialization & Connection: Initially, there was confusion about how the pg library handles the database parameter when connecting through PgBouncer. Passing database: logicalDbName within ```client.query()``` resulted in no such database errors from PostgreSQL. Later, attempts to initialize pools before PgBouncer was fully ready caused the Node.js application to hang or fail DNS lookups (ENOTFOUND pgbouncerX).

  Change: The final approach uses lazy initialization of connection pools. A separate Pool is created on demand for each logical shard (shard0, shard1, shard2) the first time it's needed. The database parameter (e.g., shard1) is set during new Pool(...) creation, ensuring the pool connects to the correct logical database defined in PgBouncer. Subsequent client.query() calls within that connection do not need the database parameter. This resolved both the hanging issue and the no such database error.

- PgBouncer Configuration Errors: Debugging revealed errors like main section missing or invalid value for parameter listen_port due to typos in filenames referenced in ```docker-compose.yml``` or comments on the same line as parameters in the ```.ini``` files.

  Change: Filenames were corrected, and comments were moved to separate lines in the ```.ini``` files.
  

In general, we need to test everything on a larger number of users. These iterative changes and debugging steps were necessary to align the theoretical configuration with the practical requirements and behaviors of the specific Docker images and libraries used, ultimately leading to a working implementation.

## 9. Stopping the Environment
```
docker-compose down
```
To remove the database volumes as well (all data will be lost):
```
docker-compose down -v
```
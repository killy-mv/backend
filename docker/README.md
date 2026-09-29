# Docker

"It works on my machine" happens because an app depends on much more than its
own code: the Node version, OS libraries, environment variables, and a Redis
running on some port. Docker packs **the app plus everything it needs** into
one file, an **image**, and runs it in an isolated box, a **container**, that
behaves the same on any machine with Docker.

```
 Dockerfile ──docker build──▶ image ──docker run──▶ container
  (recipe)                  (frozen snapshot,       (a running process
                             read-only)              with its own filesystem,
                                                     network and hostname)
```

One image can start many containers, just as one class can create many objects.

## Container vs. virtual machine

```
   Virtual machines                    Containers
 ┌──────┐ ┌──────┐                  ┌──────┐ ┌──────┐
 │ app  │ │ app  │                  │ app  │ │ app  │
 │ libs │ │ libs │                  │ libs │ │ libs │
 │  OS  │ │  OS  │ ◀ a full kernel  └──────┘ └──────┘
 └──────┘ └──────┘   each              Docker engine
   hypervisor                       ─── ONE shared kernel ───
```

A container is **not** a small VM. It's a normal process on the host that the
kernel isolates: it has its own view of files, processes and network, but it
**shares the host's kernel**. That's why it starts in milliseconds instead of
the minute a VM needs. (On Windows and Mac, Docker Desktop runs one hidden Linux
VM, and all containers share *its* kernel.)

## The examples

```
docker/
├── 2-dockerfile/
│   ├── Dockerfile           the recipe, one commented line per step
│   └── server.js            a zero-dependency Node server
└── 4-compose/
    ├── docker-compose.yml   web + redis described in one file
    └── web/                 a visit counter that stores its count in Redis
```

Examples 1 and 3 are commands only. Run everything from PowerShell.

### 1. Run an existing image

```powershell
docker run --rm hello-world
docker run --rm alpine sh -c "cat /etc/os-release; hostname; ps"
```

Docker downloads (**pulls**) the image from Docker Hub the first time, then
reuses it. `--rm` deletes the container when it exits. Inside Alpine, `ps`
shows **one process, PID 1**. The container can't see anything else running
on your machine: that's isolation.

For an interactive shell, look around and then `exit`:

```powershell
docker run --rm -it alpine sh
```

### 2. Build your own image

```powershell
cd docker/2-dockerfile
docker build -t hello-node .           # build an image named hello-node from ./Dockerfile
docker images hello-node               # ~60MB: Alpine + Node + our 1 file

docker run -d --name hello1 -p 3020:3000 hello-node
docker run -d --name hello2 -p 3022:3000 -e GREETING="second container" hello-node
```

Open http://localhost:3020 and http://localhost:3022. The result on this machine:

```json
{ "greeting": "hello from a container",
  "hostname": "6ca2641d2915",
  "platform": "Linux 6.18.33.2-microsoft-standard-WSL2" }
```

- **Same image, two containers.** Each has its own `hostname` (the container
  ID) and its own config through `-e`.
- **`-p 3020:3000`** maps port 3020 on your machine to 3000 inside the
  container. Without `-p`, the app runs but nothing outside can reach it.
- **`platform`** is the host's Linux kernel (Docker Desktop's VM). That's the
  shared kernel from the diagram above.

Useful commands while they run:

```powershell
docker ps                       # what's running
docker logs -f hello1           # its stdout (Ctrl+C to stop following)
docker exec -it hello1 sh       # open a shell INSIDE the running container
docker stop hello1; docker start hello1
docker rm -f hello1 hello2      # stop + delete
```

**Layer cache:** run `docker build` again and it finishes almost instantly,
because every step is `CACHED`. Edit `server.js` and rebuild: only the `COPY`
step and the steps after it re-run.

### 3. Containers are disposable; volumes aren't

```powershell
# Without a volume: each run starts from the clean image -> always prints 1
docker run --rm alpine sh -c "echo note >> /notes.txt; wc -l < /notes.txt"

# With a named volume: the file lives outside the container -> 1, 2, 3...
docker run --rm -v notes:/data alpine sh -c "echo note >> /data/notes.txt; wc -l < /data/notes.txt"

docker volume ls
docker volume rm notes
```

Anything a container writes to its own filesystem is gone when the container
is deleted. That's intentional, because you should be able to throw a container
away and start a fresh one at any time. Data that must survive (databases,
uploads) goes in a **volume**.

### 4. Several containers together: Compose

Real apps are several containers: a web server, a database, a cache. Instead
of long `docker run` commands, you describe them in `docker-compose.yml`.
(`caching/` already uses one for Postgres + Redis.)

```powershell
cd docker/4-compose
docker compose up -d --build     # build web's image, start web + redis
```

Refresh http://localhost:3021. The counter goes up and is stored in Redis.

| Try this | What happens | Why |
|---|---|---|
| `docker compose restart web` | count continues | the count is in Redis, not in the web process |
| `docker compose down` then `up -d` | count continues, `servedBy` changes | brand-new containers, but Redis's data is in the `redisdata` volume |
| `docker compose down -v` then `up -d` | count back to 1 | `-v` deleted the volume |
| `docker compose ps` | redis shows `6379/tcp` with no `0.0.0.0:` | redis has no `ports:`, so it's reachable only from inside the network |
| `docker compose logs -f` | both services' logs, interleaved | |

**Networking by name:** `web` connects to `redis://redis:6379`. Compose puts
all services on one private network where each **service name is a
hostname**. Inside a container, `localhost` means *that container itself*, not
your machine. That's the most common beginner mistake.

**Dockerfile order matters** (see `web/Dockerfile`): `package.json` is copied
and `npm install` runs *before* `server.js` is copied. Editing `server.js` then
reuses the cached `npm install` layer, and the rebuild takes seconds.

When done: `docker compose down -v`.

## Vocabulary

| Term | Meaning |
|---|---|
| **Image** | read-only snapshot: OS files + runtime + your app + start command |
| **Container** | a running (or stopped) instance of an image |
| **Dockerfile** | the recipe to build an image, one layer per instruction |
| **Layer** | one cached step of the build; images share common layers on disk |
| **Registry** | where images are stored and shared (Docker Hub, GHCR, ECR) |
| **Tag** | a version label: `node:22-alpine`, `hello-node:latest` |
| **Volume** | storage managed by Docker that outlives containers |
| **Port mapping** | `-p host:container`, exposing a container port on your machine |
| **Compose** | describe and run a multi-container app from one YAML file |

## Cleanup

```powershell
docker rmi hello-node 4-compose-web     # delete the images built here
docker system df                        # how much disk Docker is using
docker system prune                     # delete stopped containers, unused networks, dangling images
```

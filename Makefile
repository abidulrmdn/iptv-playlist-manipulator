.PHONY: up install free-ports

# Ports: firebase.json emulators + typical Vite dev ports (see README).
EMULATOR_PORTS := 4000 4400 4401 4500 4501 5000 5001 8080 8085 9099 9150 9199 5173 5174

# First-time: npm install, then create functions/.env and web/.env (see README).
install:
	npm install

# Kill listeners so `firebase emulators:start` and Vite can bind (safe if nothing is listening).
free-ports:
	@echo "Freeing ports used by Firebase emulators / Vite (if any)..."
	@for p in $(EMULATOR_PORTS); do \
	  pids=$$(lsof -nP -iTCP:$$p -sTCP:LISTEN -t 2>/dev/null || true); \
	  if [ -n "$$pids" ]; then \
	    echo "  port $$p -> kill $$pids"; \
	    kill $$pids 2>/dev/null || true; \
	    sleep 0.3; \
	    pids=$$(lsof -nP -iTCP:$$p -sTCP:LISTEN -t 2>/dev/null || true); \
	    if [ -n "$$pids" ]; then echo "  port $$p -> kill -9 $$pids"; kill -9 $$pids 2>/dev/null || true; fi; \
	  fi; \
	done
	@echo "Done."

up: free-ports
	@test -f functions/.env || (echo "Missing functions/.env — copy functions/.env.example and set ENCRYPTION_KEY (see README)"; exit 1)
	@test -f web/.env || (echo "Missing web/.env — copy web/.env.example (see README)"; exit 1)
	npm run up

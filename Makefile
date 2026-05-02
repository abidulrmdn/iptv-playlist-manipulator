.PHONY: up install

# First-time: npm install, then create functions/.env and web/.env (see README).
install:
	npm install

up:
	@test -f functions/.env || (echo "Missing functions/.env — copy functions/.env.example and set ENCRYPTION_KEY (see README)"; exit 1)
	@test -f web/.env || (echo "Missing web/.env — copy web/.env.example (see README)"; exit 1)
	npm run up

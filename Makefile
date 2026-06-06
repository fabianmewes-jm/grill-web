.PHONY: install start smoke check clean

install:
	npm install

start:
	npm start

smoke:
	npm run smoke

check: smoke

clean:
	rm -f npm-debug.log*

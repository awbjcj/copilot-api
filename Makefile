.PHONY: help docker-rebuild

ifeq ($(OS),Windows_NT)
GITBASH := C:/PROGRA~1/Git/bin/bash.exe
else
GITBASH := bash
endif

COPILOT_CONTAINER ?= copilot-api

help:
	@echo '  docker-rebuild Rebuild the standalone gateway from local files; preserve its data and settings'
	@echo '                 Override COPILOT_CONTAINER to select an existing container'

docker-rebuild:
	$(GITBASH) scripts/rebuild-docker.sh "$(COPILOT_CONTAINER)"

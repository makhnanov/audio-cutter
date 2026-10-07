# Аудио-резак — локальный запуск
#
#   make        запустить сервер (Ctrl+C — остановить)
#   make open   запустить и открыть страницу в браузере
#   make stop   прибить сервер, забытый в фоне
#
# Порт и адрес можно переопределить:  make PORT=9000

PORT ?= 8777
HOST ?= 127.0.0.1
URL   = http://$(HOST):$(PORT)/

.DEFAULT_GOAL := run
.PHONY: run open stop

run:
	@echo "Аудио-резак → $(URL)"
	@echo "Ctrl+C — остановить."
	@echo
	@trap 'echo; echo "Сервер остановлен."; exit 0' INT; \
	python3 -m http.server $(PORT) --bind $(HOST) --directory $(CURDIR)

open:
	@(sleep 1; xdg-open $(URL) >/dev/null 2>&1 &) 
	@$(MAKE) --no-print-directory run

stop:
	@pkill -f "http.server $(PORT)" && echo "Сервер остановлен." || echo "Сервер не запущен."

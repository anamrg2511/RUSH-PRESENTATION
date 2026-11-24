/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.VITE_API_PROXY ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Bind to every network interface so a second computer on the same Wi-Fi can open
    // http://<this-computer-LAN-IP>:5173 (needed for two-computer multiplayer; see README).
    host: true,
    // Same-origin API: the session cookie and Socket.IO work without CORS.
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/media': { target: API, changeOrigin: false },
      '/socket.io': { target: API, ws: true, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Configura Vite (servidor de desarrollo y compilación) y Vitest para el frontend.

Responsabilidades principales:
- Plugins de React y Tailwind CSS.
- Servidor en el puerto 5173 con proxy de /api, /media y /socket.io (WebSocket) hacia el backend
  (VITE_API_PROXY o http://localhost:4000).
- Pruebas con entorno jsdom y archivo de preparación src/test/setup.ts.

Elementos importantes:
- defineConfig({...})

Dependencias:
- vite
- @vitejs/plugin-react
- @tailwindcss/vite

Flujo de datos:
Determina cómo se sirve el frontend y cómo llegan sus peticiones al backend.

Aspectos técnicos importantes:
- El proxy hace que frontend y backend compartan origen, así la cookie de sesión funciona sin CORS.

Lugar en la arquitectura:
Herramienta de construcción. Une frontend y backend durante el desarrollo.
*/

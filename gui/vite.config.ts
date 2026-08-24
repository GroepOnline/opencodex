import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Bake the parent package version into the bundle as a fallback for moments when the runtime
// `/healthz` version is not reachable yet.
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const proxyTarget = process.env.OPENCODEX_PROXY_TARGET
const previewPort = process.env.PORT && /^\d+$/.test(process.env.PORT) ? Number(process.env.PORT) : undefined

function proxyConfig(target: string) {
  return {
    '/api': { target, changeOrigin: true },
    '/healthz': { target, changeOrigin: true },
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function guiSessionPlugin(target: string | undefined) {
  return {
    name: 'opencodex-gui-session',
    async transformIndexHtml(html: string) {
      if (!target) return html
      try {
        const response = await fetch(`${target}/__opencodex_gui_session`)
        if (!response.ok) return html
        const session = await response.json() as { token?: string; csrfToken?: string; origin?: string }
        if (!session.token || !session.csrfToken || !session.origin) return html
        const tags = [
          ['opencodex-session-token', session.token],
          ['opencodex-session-csrf', session.csrfToken],
          ['opencodex-session-origin', session.origin],
        ].map(([name, value]) => `<meta name="${name}" content="${escapeHtmlAttribute(value)}">`).join('')
        return html.replace('</head>', `${tags}</head>`)
      } catch {
        return html
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), guiSessionPlugin(proxyTarget)],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { rollupOptions: { output: { manualChunks(id) { if (id.includes('src/pages/Usage')) return 'usage'; if (id.includes('src/pages/Verkeer')) return 'verkeer'; if (id.includes('src/pages/Dashboard')) return 'dashboard'; if (id.includes('src/pages/Providers')) return 'providers'; if (id.includes('src/pages/Modellen') || id.includes('src/pages/Models')) return 'modellen'; if (id.includes('src/pages/Claude')) return 'claude'; if (id.includes('src/pages/Grok') || id.includes('src/pages/ApiKeys') || id.includes('api-keys-panels')) return 'grok-apikeys'; if (id.includes('src/pages/Storage') || id.includes('src/pages/Logs') || id.includes('src/pages/Instellingen') || id.includes('src/pages/Debug')) return 'storage-logs'; if (id.includes('src/pages/Combos') || id.includes('src/pages/Subagents') || id.includes('src/pages/Startup')) return 'combos-subagents'; } } } },
  /* [Decision Log]
  - 목적: 로컬 Vite GUI가 실행 중인 opencodex API를 same-origin으로 호출해 CORS 잡음 없이 실제 데이터를 보여준다.
  - 대안 분석: API 없이 정적 화면만 띄우면 기능 검증이 불가능하고, 별도 프록시 서버는 유지보수 대상이 늘며, Vite 내장 proxy는 개발 시에만 기존 서버를 재사용한다.
  - 선택 근거: 환경변수가 있을 때만 활성화되어 프로덕션 번들과 기본 개발 동작을 바꾸지 않고 로컬 통합 검증에 필요한 경로만 연결한다.
  */
  server: {
    host: '0.0.0.0',
    ...(previewPort ? { port: previewPort } : {}),
    ...(proxyTarget ? { proxy: proxyConfig(proxyTarget) } : {}),
  },
})

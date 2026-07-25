// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Fork docs — not currently deployed, but config stays ready for GitHub Pages.
const SITE_URL = "https://github.com/OnlineChefGroep/opencodex";

const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: "opencodex (OnlineChefGroep fork)",
      description:
        "Universal provider proxy for OpenAI Codex & Claude Code — use any LLM with Codex CLI, App, SDK, and Claude Code.",
      inLanguage: ["en", "ko", "zh-CN", "ru", "ja"],
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: "opencodex",
      alternateName: "ocx",
      description:
        "Local LLM proxy that lets OpenAI Codex (CLI, App, SDK) and Claude Code run on any model — Claude, Gemini, Grok, DeepSeek, Kimi, Qwen, Ollama, OpenRouter, and more — with streaming, tool calls, reasoning tokens, and images working in both directions.",
      keywords:
        "codex, claude code, openai codex proxy, claude code proxy, llm proxy, ai gateway, anthropic, gemini, grok, deepseek, ollama, openrouter, responses api, codex cli",
      featureList: [
        "Run Codex CLI/App/SDK on any LLM provider",
        "Run Claude Code on any LLM via the Anthropic Messages API",
        "ChatGPT account pool with quota-aware routing",
        "Streaming, tool calls, reasoning tokens, and vision in both directions",
        "Web dashboard on localhost:10100",
      ],
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      softwareHelp: { "@type": "CreativeWork", url: `${SITE_URL}/` },
      downloadUrl: "https://www.npmjs.com/package/@bitkyc08/opencodex",
      url: "https://github.com/OnlineChefGroep/opencodex",
    },
  ],
});

export default defineConfig({
  site: SITE_URL,
  base: "/",
  trailingSlash: "ignore",
  vite: { build: { cssMinify: "esbuild" } },
  integrations: [
    starlight({
      title: "opencodex",
      description:
        "Universal provider proxy for OpenAI Codex & Claude Code — use any LLM with Codex CLI, App, SDK, and Claude Code.",
      tagline: "Use any LLM with OpenAI Codex and Claude Code.",
      logo: {
        light: "./src/assets/logo-light.png",
        dark: "./src/assets/logo-dark.png",
        replacesTitle: false,
      },
      favicon: "/favicon.png",
      customCss: [
        "@fontsource-variable/geist",
        "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css",
        "./src/styles/custom.css",
      ],
      components: {
        Header: "./src/components/Header.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      head: [
        { tag: "meta", attrs: { property: "og:image", content: `${SITE_URL}/og.png` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${SITE_URL}/og.png` } },
        { tag: "meta", attrs: { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#ffffff" } },
        { tag: "meta", attrs: { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#212121" } },
        { tag: "script", attrs: { type: "application/ld+json" }, content: jsonLd },
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/OnlineChefGroep/opencodex" },
      ],
      editLink: {
        baseUrl: "https://github.com/OnlineChefGroep/opencodex/edit/main/docs-site/",
      },
      lastUpdated: true,
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ko: { label: "한국어", lang: "ko" },
        "zh-cn": { label: "简体中文", lang: "zh-CN" },
        ru: { label: "Русский", lang: "ru" },
        ja: { label: "日本語", lang: "ja" },
      },
      sidebar: [
        {
          label: "Getting started",
          translations: {
            ko: "시작하기",
            "zh-cn": "开始使用",
            ru: "Начало работы",
            ja: "はじめに",
          },
          autogenerate: { directory: "getting-started" },
        },
        {
          label: "Providers",
          translations: {
            ko: "프로바이더",
            "zh-cn": "Provider",
            ru: "Провайдеры",
            ja: "プロバイダー",
          },
          autogenerate: { directory: "providers" },
        },
        {
          label: "Guides",
          translations: {
            ko: "가이드",
            "zh-cn": "指南",
            ru: "Руководства",
            ja: "ガイド",
          },
          autogenerate: { directory: "guides" },
        },
        {
          label: "Reference",
          translations: {
            ko: "레퍼런스",
            "zh-cn": "参考",
            ru: "Справочник",
            ja: "リファレンス",
          },
          autogenerate: { directory: "reference" },
        },
      ],
    }),
  ],
});

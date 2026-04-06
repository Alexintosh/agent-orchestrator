import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Agent Orchestrator",
  description:
    "Schedule, execute, and manage sessions for CLI-based AI agents",
  base: "/",
  cleanUrls: true,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
  ],

  themeConfig: {
    logo: "/logo.svg",

    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "API", link: "/api/orchestrator" },
      { text: "Examples", link: "/examples/single-agent" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "What is Agent Orchestrator?", link: "/guide/what-is-it" },
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Architecture", link: "/guide/architecture" },
          ],
        },
        {
          text: "Core Concepts",
          items: [
            { text: "Adapters", link: "/guide/adapters" },
            { text: "Sessions", link: "/guide/sessions" },
            { text: "Scheduling", link: "/guide/scheduling" },
            { text: "Storage", link: "/guide/storage" },
          ],
        },
      ],
      "/api/": [
        {
          text: "API Reference",
          items: [
            { text: "createOrchestrator", link: "/api/orchestrator" },
            { text: "Adapters", link: "/api/adapters" },
            { text: "Store Interface", link: "/api/store" },
            { text: "Types", link: "/api/types" },
          ],
        },
      ],
      "/examples/": [
        {
          text: "Examples",
          items: [
            { text: "Single Agent Runner", link: "/examples/single-agent" },
            { text: "Multi-Session Resume", link: "/examples/multi-session" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/example/agent-orchestrator" },
    ],

    search: {
      provider: "local",
    },

    footer: {
      message: "Released under the MIT License.",
    },
  },
});

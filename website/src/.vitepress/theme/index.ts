import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Home from './Home.vue'
import ChangelogFilter from './ChangelogFilter.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Home', Home)
    app.component('ChangelogFilter', ChangelogFilter)
  },
} satisfies Theme

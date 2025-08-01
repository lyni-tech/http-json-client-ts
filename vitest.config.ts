import {UserConfig} from 'vite'
import {defineConfig} from 'vitest/config'

const config: UserConfig = defineConfig({
    test: {
        coverage: {
            enabled: true,
            clean: true,
            reporter: "text-summary"
        },
    },
})
export default config

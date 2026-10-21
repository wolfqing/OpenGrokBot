import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'

// 整页渲染的 App 测试在 CI 的小 runner 上偶尔要一秒多才就绪；默认 1 秒的等待在那里不够用
configure({ asyncUtilTimeout: 3000 })

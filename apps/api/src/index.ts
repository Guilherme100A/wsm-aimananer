// @wsm/api — entrypoint do servidor HTTP (Hono). O app é montado em src/app.ts (T03).
import { CORE_PACKAGE } from '@wsm/core'

export const API_PACKAGE = '@wsm/api'
export const dependsOn = [CORE_PACKAGE]

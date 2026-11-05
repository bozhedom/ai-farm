import { defineEventHandler } from 'h3'
import { availableModels } from '../../../../core/agent-profiles'
import { respond } from '../../../utils/api'
export default defineEventHandler(() => respond(() => availableModels()))

import { defineEventHandler } from 'h3'
import { walletView } from '../../../../core/wallet/view'
import { respond } from '../../../../server/utils/api'

export default defineEventHandler(() => respond(() => walletView()))

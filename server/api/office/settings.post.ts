import { defineEventHandler } from 'h3'
import { farmSettingsSchema, updateFarmSettings } from '../../../core/autonomy'
import { officeSettings } from '../../../core/office'
import { body, respond } from '../../../server/utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    await updateFarmSettings(await body(event, farmSettingsSchema))
    return officeSettings()
  }),
)

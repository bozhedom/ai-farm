import { defineEventHandler } from 'h3'
import { profilesView } from '../../../../core/agent-profiles'
import { prepareStepRequest, prepareDocumentRequest } from '../../../../core/computer-use/model'
import { withAgentProfiles } from '../../../../core/agent-profiles'
import { respond } from '../../../utils/api'

export default defineEventHandler(() =>
  respond(() =>
    withAgentProfiles(async () => {
      const view = await profilesView()
      const browser = view.roles.find((r) => r.id === 'browser')!
      browser.effectivePrompt = prepareStepRequest({
        taskId: 'preview',
        reservationId: '',
        goal: '',
        stepNo: 1,
        stepLimit: 1,
        history: [],
        page: { url: 'https://example.com', title: '' },
        png: null,
        opportunities: 0,
      }).system
      view.roles.find((r) => r.id === 'platform-writer')!.effectivePrompt = prepareDocumentRequest({
        taskId: 'preview',
        reservationId: '',
        stepNo: 1,
        goal: '',
        title: '',
        brief: '',
        kind: 'other',
      }).system
      return view
    }),
  ),
)

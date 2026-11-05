import type { WorkFocusView } from '../../../core/contracts/work-focus'
import { officeFetch, useOfficeResource } from './resource'
export const useWorkFocus = () =>
  useOfficeResource<WorkFocusView>(
    () => 'work-focus',
    () => officeFetch('/api/office/focus'),
    { interval: 10000 },
  )

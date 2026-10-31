// What a page shows before the first picture of the Macs and sessions has arrived: a spinner while it comes, and
// a failure with 다시 시도 when the stream cannot be reached. Never "연결된 맥이 없어요" or "맥을 연결해 주세요": with
// nothing read yet, those claimed something that was not known (and sent people off to connect a Mac again).
import { LoadError, Spinner } from '../kit'
import { useStore } from '../lib/store'

/** True once the first state has arrived (from the stream, or this browser's copy of the last one). */
export const useStateLoaded = () => useStore((s) => s.state != null)

export function StateWait() {
  const failed = useStore((s) => s.link === 'retrying')
  if (failed) return <LoadError what="맥과 세션 목록을" onRetry={() => location.reload()} />
  return (
    <div className="page-wait" role="status" aria-label="불러오는 중">
      <Spinner />
    </div>
  )
}

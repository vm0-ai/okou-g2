import { useEffect, type ReactNode } from 'react'
import { useOrganization, useOrganizationList } from '@clerk/clerk-react'

/**
 * Ensure the Clerk session has an active organization.
 *
 * Every Okou chat API resolves its organization from the session token's
 * `org_id` claim, so a session without one cannot read threads at all. A
 * sign-in on this device does not set an active organization by itself, and
 * the Even App has no organization switcher, so the first membership is
 * selected automatically and a picker only appears when there are several.
 */
export default function OrganizationGate({
  children,
}: {
  children: (orgId: string) => ReactNode
}) {
  const { organization, isLoaded: orgLoaded } = useOrganization()
  const { isLoaded: listLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  })

  const memberships = userMemberships?.data ?? []
  const onlyMembership = memberships.length === 1 ? memberships[0] : undefined

  useEffect(() => {
    if (!listLoaded || !orgLoaded || organization || !onlyMembership || !setActive) return
    void setActive({ organization: onlyMembership.organization.id })
  }, [listLoaded, orgLoaded, organization, onlyMembership, setActive])

  if (!orgLoaded || !listLoaded) {
    return (
      <section className="card">
        <p className="hint">Loading organization…</p>
      </section>
    )
  }

  if (organization) return <>{children(organization.id)}</>

  if (memberships.length === 0) {
    return (
      <section className="card">
        <h2>No organization</h2>
        <p className="hint">
          This Okou account has no organization, so there are no chats to sync. Create one at
          app.okou.ai and reopen this app.
        </p>
      </section>
    )
  }

  return (
    <section className="card">
      <h2>Choose organization</h2>
      <p className="hint">Chats are stored per organization. Pick the one to sync.</p>
      {memberships.map((membership) => (
        <button
          key={membership.organization.id}
          type="button"
          onClick={() => void setActive?.({ organization: membership.organization.id })}
        >
          {membership.organization.name}
        </button>
      ))}
    </section>
  )
}

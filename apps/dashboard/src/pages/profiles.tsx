import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, PageHeader, QueryError } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, errorMessage, unwrap } from '@/lib/api'
import { ago } from '@/lib/format'

// Profiles of this server (read-only for now, plan §7): they're created and
// edited in the clients' "Who's watching?" screen.
export function ProfilesPage() {
  const client = useQueryClient()
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => unwrap(api.GET('/profiles')) })
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/profiles/{profileId}', { params: { path: { profileId: id } } })),
    onSuccess: () => {
      toast.success('Profile deleted')
      client.invalidateQueries({ queryKey: ['profiles'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (profiles.isPending) return <Loading />
  if (profiles.error) return <QueryError error={profiles.error} />
  const list = profiles.data.profiles
  return (
    <>
      <PageHeader title="Profiles" description={`Created in the clients' “Who's watching?” screen. ${list.length} of ${profiles.data.maxProfiles}.`} />
      {list.length === 0 ? (
        <Empty icon={<Users />} title="No profiles yet">
          Open Playpex TV on any device paired with this server and add one on its “Who&apos;s watching?” screen.
        </Empty>
      ) : (
        <Card>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Last used</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{p.name}</span>
                        {p.isKid && <Badge variant="secondary">Kids</Badge>}
                        {p.hasPin && (
                          <Badge variant="outline">
                            <Lock /> PIN
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{p.lastUsedAt ? ago(p.lastUsedAt) : 'never'}</TableCell>
                    <TableCell>
                      <Confirm
                        title={`Delete ${p.name}?`}
                        description="Its watch list, resume points, history and ratings are deleted too. This can't be undone."
                        action="Delete"
                        onConfirm={() => remove.mutate(p.id)}
                        trigger={
                          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${p.name}`}>
                            <Trash2 />
                          </Button>
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  )
}

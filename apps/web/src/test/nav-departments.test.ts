import { describe, expect, it } from 'vitest';
import { sectionItems } from '@/components/Layout';

/** The menu follows the departments feature, and changes nothing while it is off. */
const routes = (role: 'dispatcher' | 'admin' | 'volunteer', section: 'more' | 'admin', features: Parameters<typeof sectionItems>[3]) =>
  sectionItems(role, [], section, features).map((i) => i.to);

describe('menu and departments', () => {
  const off = { announcements: true };

  it('feature off: the menu is exactly as before (no Departments page)', () => {
    expect(routes('admin', 'admin', off)).not.toContain('/admin/departments');
    expect(routes('dispatcher', 'more', off)).toEqual(expect.arrayContaining(['/recurring', '/equipment']));
  });

  it('feature on: admins get the Departments page', () => {
    expect(routes('admin', 'admin', { ...off, flags: { departmentScoping: true } })).toContain('/admin/departments');
  });

  it('a coordinator limited to food does not see equipment or standing rides', () => {
    const more = routes('dispatcher', 'more', { ...off, flags: { departmentScoping: true }, departments: ['food'] });
    expect(more).not.toContain('/equipment');
    expect(more).not.toContain('/recurring');
    expect(more).toContain('/duty');
  });

  it('a coordinator in no department, and every volunteer, see everything as before', () => {
    expect(routes('dispatcher', 'more', { ...off, flags: { departmentScoping: true }, departments: null })).toEqual(expect.arrayContaining(['/recurring', '/equipment']));
    expect(routes('volunteer', 'more', { ...off, flags: { departmentScoping: true }, departments: ['food'] })).toContain('/equipment');
  });
});

import React from 'react';
import { BackupDownload } from '@/components/BackupDownload';
import { PageHeader } from '@/components/states';

export function BackupPage(): React.JSX.Element {
  return <div className="space-y-6">
    <PageHeader title="Full backup" subtitle="Save an encrypted copy outside Render" />
    <BackupDownload />
  </div>;
}

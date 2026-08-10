import * as vscode from 'vscode';
import { RendererPerformance } from '../../domain/renderer';
import { COMMANDS, CONFIGURATION_SECTION } from '../constants';

type ProfileSetting = RendererPerformance['profile'] | 'project';

export async function selectPerformanceProfile(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const current = configuration.get<ProfileSetting>('performanceProfile', 'project');
  const items: Array<vscode.QuickPickItem & { value: ProfileSetting }> = [
    {
      label: '高质量',
      description: current === 'quality' ? '当前选择' : '优先使用原始或最高质量媒体，保留全部效果',
      value: 'quality'
    },
    {
      label: '均衡',
      description: current === 'balanced' ? '当前选择' : '降低视频分辨率、帧率和部分持续效果',
      value: 'balanced'
    },
    {
      label: '省电',
      description: current === 'economy' ? '当前选择' : '优先最低负载媒体，并关闭高成本效果',
      value: 'economy'
    },
    {
      label: '跟随壁纸配置',
      description: current === 'project' ? '当前选择' : '使用 wallpaper.json 中的 performance.profile',
      value: 'project'
    }
  ];
  const selected = await vscode.window.showQuickPick(items, {
    title: 'Dynamic Wallpaper：选择画质档位',
    placeHolder: '此选择会覆盖 wallpaper.json 中的性能档位'
  });
  if (!selected) {
    return;
  }

  await configuration.update(
    'performanceProfile',
    selected.value,
    vscode.ConfigurationTarget.Global
  );
  const action = await vscode.window.showInformationMessage(
    `壁纸画质档位已切换为“${selected.label}”。重新应用后生效。`,
    '应用并重启'
  );
  if (action === '应用并重启') {
    await vscode.commands.executeCommand(COMMANDS.apply);
  }
}

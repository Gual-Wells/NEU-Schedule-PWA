window.APP_DATA = {
  semester: {
    name: '2026-2027 秋季学期',
    // 以实际教学周校准：2026-09-24 为第4周，因此第1周周一为 2026-08-31。
    week1Monday: '2026-08-31',
    totalWeeks: 26
  },
  periods: {
    1: ['08:30', '09:15'],
    2: ['09:25', '10:10'],
    3: ['10:30', '11:15'],
    4: ['11:25', '12:10'],
    5: ['14:00', '14:45'],
    6: ['14:55', '15:40'],
    7: ['16:00', '16:45'],
    8: ['16:55', '17:40'],
    9: ['18:30', '19:15'],
    10: ['19:25', '20:10'],
    11: ['20:20', '21:05'],
    12: ['21:15', '22:00']
  },
  courses: [
    { name: '国际会议交流英语', weekday: 3, start: 1, end: 2, teacher: '李碧玉', location: '1号B303', weeks: '2-17', className: '02班（浑南）' },
    { name: '高级软件过程管理', weekday: 6, start: 1, end: 4, teacher: '刘益先', location: '信息A101', weeks: '13-14、16-17', className: '' },
    { name: '高级人工智能', weekday: 1, start: 5, end: 8, teacher: '于瑞云', location: '1号A203', weeks: '11-18', className: '' },
    { name: '应用数理统计', weekday: 2, start: 5, end: 6, teacher: '孙平', location: '生命B101', weeks: '2-13', className: '04班（浑南）' },
    { name: '应用数理统计', weekday: 5, start: 7, end: 8, teacher: '孙平', location: '生命B101', weeks: '2-13', className: '04班（浑南）' },
    { name: '思想政治理论课（硕士必修）', weekday: 3, start: 5, end: 8, teacher: '姜耀东', location: '1号A303', weeks: '2、4-11', className: '05班（浑南）' },
    { name: '工程伦理', weekday: 4, start: 5, end: 8, teacher: '曹东溟', location: '信息A114', weeks: '2-4、6', className: '04班（浑南）' },
    { name: '思想政治理论课（硕士理工类必选）', weekday: 4, start: 5, end: 8, teacher: '曹东溟', location: '1号A307', weeks: '8-11', className: '03班（浑南）' },
    { name: '思想政治理论课（硕士理工类必选）', weekday: 4, start: 5, end: 6, teacher: '曹东溟', location: '1号A307', weeks: '12', className: '03班（浑南）' },
    { name: '体育', weekday: 5, start: 7, end: 8, teacher: '于明', location: '1号A205', weeks: '1', className: '07班' },
    { name: '论文写作与学术规范', weekday: 1, start: 9, end: 12, teacher: '郭贵冰', location: '1号A303', weeks: '2-5', className: '' },
    { name: '前沿软件体系结构', weekday: 3, start: 9, end: 10, teacher: '石凯', location: '1号A203', weeks: '2-5、7-10', className: '' },
    // 仅用于 2026-09-26 的后台推送实测；收到用户反馈后移除。
    { name: '临时推送测试课', weekday: 6, date: '2026-09-26', start: 7, end: 7, startTime: '15:50', endTime: '16:35', teacher: '测试', location: '临时测试', weeks: '4', className: '', testOnly: true }
  ],
  gym: {
    updated: '2026-09-04',
    // 根据用户提供的“健身房可用时段”照片转录。
    // weekday: 1=周一 ... 7=周日；每一项为可用时间段。
    overrides: { '2026-09-26': [['15:50', '20:40']] },
    availability: {
      1: [['07:00', '10:00'], ['12:10', '13:50'], ['17:40', '20:40']],
      2: [['07:00', '10:00'], ['12:10', '13:50'], ['17:40', '20:40']],
      3: [['07:00', '20:40']],
      4: [['07:00', '10:00'], ['12:10', '13:50'], ['17:40', '20:40']],
      5: [['07:00', '10:00'], ['12:10', '13:50'], ['17:40', '20:40']],
      6: [['07:00', '20:40']],
      7: [['07:00', '20:40']]
    }
  }
};

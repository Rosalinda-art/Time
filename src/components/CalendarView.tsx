import React, { useMemo, useState, useEffect } from 'react';
import { Calendar, momentLocalizer, Views } from 'react-big-calendar';
import moment from 'moment';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { StudyPlan, FixedCommitment, Task } from '../types';
import { BookOpen, Clock, Settings, X } from 'lucide-react';
import { checkSessionStatus } from '../utils/scheduling';
import { getLocalDateString } from '../utils/scheduling';
import MobileCalendarView from './MobileCalendarView';
import CommitmentSessionManager from './CommitmentSessionManager';

const localizer = momentLocalizer(moment);

interface CalendarViewProps {
  studyPlans: StudyPlan[];
  fixedCommitments: FixedCommitment[];
  tasks: Task[];
  onSelectTask?: (task: Task, session?: { allocatedHours: number; planDate?: string; sessionNumber?: number }) => void;
  onStartManualSession?: (commitment: FixedCommitment, durationSeconds: number) => void;
  onDeleteFixedCommitment?: (commitmentId: string) => void;
  onDeleteCommitmentSession?: (commitmentId: string, date: string) => void;
  onEditCommitmentSession?: (commitmentId: string, date: string, updates: {
    startTime?: string;
    endTime?: string;
    title?: string;
    type?: 'class' | 'work' | 'appointment' | 'other' | 'buffer';
  }) => void;
}

interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  resource: {
    type: 'study' | 'commitment';
    data: any;
  };
}

const intervalOptions = [
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
];

// Color palette for up to 8 categories
const CATEGORY_COLORS = [
  '#6366f1', // Indigo
  '#f59e42', // Orange
  '#10b981', // Green
  '#f43f5e', // Red
  '#eab308', // Yellow
  '#3b82f6', // Blue
  '#a21caf', // Purple
  '#14b8a6', // Teal
];
const DEFAULT_UNCATEGORIZED_TASK_COLOR = '#d97706'; // Light brown for uncategorized tasks



const DEFAULT_COMMITMENT_TYPE_COLORS: Record<string, string> = {
  class: '#3b82f6',     // Blue
  work: '#a21caf',      // Purple
  appointment: '#f59e42', // Orange
  other: '#14b8a6',     // Teal
  buffer: '#6366f1',    // Indigo
};


const DEFAULT_MISSED_COLOR = '#dc2626'; // Darker Red
const DEFAULT_OVERDUE_COLOR = '#c2410c'; // Even Darker Orange
const DEFAULT_COMPLETED_COLOR = '#d1d5db'; // Gray
const DEFAULT_IMPORTANT_TASK_COLOR = '#f59e0b'; // Amber
const DEFAULT_NOT_IMPORTANT_TASK_COLOR = '#64748b'; // Gray
const COMMITMENT_DEFAULT_COLOR = '#64748b';

interface ColorSettings {
  commitmentTypeColors: Record<string, string>;
  missedColor: string;
  overdueColor: string;
  completedColor: string;
  importantTaskColor: string;
  notImportantTaskColor: string;
  commitmentColor: string;
  uncategorizedTaskColor: string;
}

// Utility to split an event if it crosses midnight
function splitEventIfCrossesMidnight(start: Date, end: Date) {
  if (
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate()
  ) {
    return [{ start, end }];
  } else {
    // Split into two events: one until 23:59:59, one from 00:00:00
    const endOfStartDay = new Date(start);
    endOfStartDay.setHours(23, 59, 59, 999);
    const startOfEndDay = new Date(end);
    startOfEndDay.setHours(0, 0, 0, 0);
    return [
      { start, end: endOfStartDay },
      { start: startOfEndDay, end }
    ];
  }
}

const CalendarView: React.FC<CalendarViewProps> = ({
  studyPlans,
  fixedCommitments,
  tasks,
  onSelectTask,
  onStartManualSession,
  onDeleteFixedCommitment,
  onDeleteCommitmentSession,
  onEditCommitmentSession,
}) => {
  const [timeInterval, setTimeInterval] = useState(() => {
    const saved = localStorage.getItem('timepilot-calendar-interval');
    if (saved) {
      const parsed = parseInt(saved);
      if ([5, 10, 15, 30, 60].includes(parsed)) {
        return parsed;
      }
    }
    return 30; // Default to 30 minutes
  });
  const [showColorSettings, setShowColorSettings] = useState(false);
  const [colorSettings, setColorSettings] = useState<ColorSettings>(() => {
    const saved = localStorage.getItem('timepilot-calendar-colors');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        // Fallback to defaults if parsing fails
      }
    }
    return {
      commitmentTypeColors: { ...DEFAULT_COMMITMENT_TYPE_COLORS },
      missedColor: DEFAULT_MISSED_COLOR,
      overdueColor: DEFAULT_OVERDUE_COLOR,
      completedColor: DEFAULT_COMPLETED_COLOR,
      importantTaskColor: DEFAULT_IMPORTANT_TASK_COLOR,
      notImportantTaskColor: DEFAULT_NOT_IMPORTANT_TASK_COLOR,
      commitmentColor: '#64748b', // Add commitment color setting
      uncategorizedTaskColor: DEFAULT_UNCATEGORIZED_TASK_COLOR,
    };
  });
  const [selectedManualSession, setSelectedManualSession] = useState<FixedCommitment | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [showSessionManager, setShowSessionManager] = useState(false);
  const [selectedSessionToManage, setSelectedSessionToManage] = useState<{
    commitment: FixedCommitment;
    date: string;
  } | null>(null);


  // Mobile detection
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Save color settings to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('timepilot-calendar-colors', JSON.stringify(colorSettings));
  }, [colorSettings]);

  // Save time interval to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('timepilot-calendar-interval', timeInterval.toString());
  }, [timeInterval]);

  const handleSpecialColorChange = (key: keyof ColorSettings, color: string) => {
    setColorSettings(prev => ({
      ...prev,
      [key]: color
    }));
  };

  const resetToDefaults = () => {
    setColorSettings({
      commitmentTypeColors: { ...DEFAULT_COMMITMENT_TYPE_COLORS },
      missedColor: DEFAULT_MISSED_COLOR,
      overdueColor: DEFAULT_OVERDUE_COLOR,
      completedColor: DEFAULT_COMPLETED_COLOR,
      importantTaskColor: DEFAULT_IMPORTANT_TASK_COLOR,
      notImportantTaskColor: DEFAULT_NOT_IMPORTANT_TASK_COLOR,
      commitmentColor: '#64748b',
      uncategorizedTaskColor: DEFAULT_UNCATEGORIZED_TASK_COLOR,
    });
  };

  const events: CalendarEvent[] = useMemo(() => {
    const calendarEvents: CalendarEvent[] = [];

    // Convert study plans to calendar events
    studyPlans.forEach(plan => {
      // Sort the planned tasks by priority and time before creating events
      const sortedTasks = [...plan.plannedTasks].sort((a, b) => {
        // Check session status for missed sessions
        const aStatus = checkSessionStatus(a, plan.date);
        const bStatus = checkSessionStatus(b, plan.date);
        
        // If one is missed and the other isn't, put missed sessions at the end
        if (aStatus === 'missed' && bStatus !== 'missed') {
          return 1; // a (missed) goes after b
        }
        if (aStatus !== 'missed' && bStatus === 'missed') {
          return -1; // b (missed) goes after a
        }
        if (aStatus === 'missed' && bStatus === 'missed') {
          // Both are missed, sort by original time
          const [aH, aM] = a.startTime.split(':').map(Number);
          const [bH, bM] = b.startTime.split(':').map(Number);
          const aMinutes = aH * 60 + aM;
          const bMinutes = bH * 60 + bM;
          return aMinutes - bMinutes;
        }
        
        // Both are not missed, sort by priority first, then by start time
        const taskA = tasks.find(t => t.id === a.taskId);
        const taskB = tasks.find(t => t.id === b.taskId);
        
        if (!taskA || !taskB) {
          // Fallback to time-based sorting if tasks not found
          const [aH, aM] = a.startTime.split(':').map(Number);
          const [bH, bM] = b.startTime.split(':').map(Number);
          const aMinutes = aH * 60 + aM;
          const bMinutes = bH * 60 + bM;
          return aMinutes - bMinutes;
        }
        
        // Priority order: high (3) > medium (2) > low (1)
        // const priorityOrder: { [key: string]: number } = { high: 3, medium: 2, low: 1 };
        // const priorityA = priorityOrder[taskA.priority] || 0;
        // const priorityB = priorityOrder[taskB.priority] || 0;
        // If priorities are different, sort by priority (higher first)
        // if (priorityA !== priorityB) {
        //   return priorityB - priorityA; // Higher priority first
        // }
        // Instead, use importance: true (high) > false (low)
        if (taskA.importance !== taskB.importance) {
          return taskB.importance ? 1 : -1; // true (high) comes first
        }
        
        // If priorities are the same, sort by start time
        const [aH, aM] = a.startTime.split(':').map(Number);
        const [bH, bM] = b.startTime.split(':').map(Number);
        const aMinutes = aH * 60 + aM;
        const bMinutes = bH * 60 + bM;
        return aMinutes - bMinutes;
      });

      sortedTasks.forEach(session => {
        const task = tasks.find(t => t.id === session.taskId);
        if (!task) return;

        const planDate = plan.date; // Always set planDate explicitly
        const startDateTime = new Date(planDate);
        const [startHour, startMinute] = session.startTime.split(':').map(Number);
        startDateTime.setHours(startHour, startMinute, 0, 0);
        const endDateTime = new Date(planDate);
        const [endHour, endMinute] = session.endTime.split(':').map(Number);
        endDateTime.setHours(endHour, endMinute, 0, 0);

        // Split if crosses midnight
        splitEventIfCrossesMidnight(startDateTime, endDateTime).forEach(({ start, end }, idx) => {
          // Create a more unique ID that includes session number and start time to prevent duplicates
          const uniqueId = `study-${session.taskId}-${plan.date}-${session.sessionNumber || 0}-${session.startTime.replace(':', '')}-${idx}`;
          calendarEvents.push({
            id: uniqueId,
            title: `${plan.isLocked ? '🔒 ' : ''}${task.title}`,
            start,
            end,
            resource: {
              type: 'study',
              data: { 
                ...session, 
                task, 
                planDate,
                isLocked: plan.isLocked,
                status: checkSessionStatus(session, planDate)
              }
            }
          });
        });
      });
    });

    // Convert fixed commitments to calendar events
    fixedCommitments.forEach(commitment => {
      if (commitment.recurring) {
        // Handle recurring commitments
        const today = new Date();
        // Extend the range to 365 days (1 year) to prevent days from getting cut off
        const endDate = new Date();
        endDate.setDate(today.getDate() + 365);
        const currentDate = new Date(today);
        while (currentDate <= endDate) {
          if (commitment.daysOfWeek.includes(currentDate.getDay())) {
            const dateString = currentDate.toISOString().split('T')[0];
            
            // Skip deleted occurrences
            if (commitment.deletedOccurrences?.includes(dateString)) {
              currentDate.setDate(currentDate.getDate() + 1);
              continue;
            }
            
            // Check for modified occurrence
            const modifiedSession = commitment.modifiedOccurrences?.[dateString];
            
            const startDateTime = new Date(currentDate);
            const [startHour, startMinute] = (modifiedSession?.startTime || commitment.startTime).split(':').map(Number);
            startDateTime.setHours(startHour, startMinute, 0, 0);
            const endDateTime = new Date(currentDate);
            const [endHour, endMinute] = (modifiedSession?.endTime || commitment.endTime).split(':').map(Number);
            endDateTime.setHours(endHour, endMinute, 0, 0);
            
            // Split if crosses midnight
            splitEventIfCrossesMidnight(startDateTime, endDateTime).forEach(({ start, end }, idx) => {
              const uniqueId = `commitment-${commitment.id}-${currentDate.toISOString().split('T')[0]}-${(modifiedSession?.startTime || commitment.startTime).replace(':', '')}-${idx}`;
              calendarEvents.push({
                id: uniqueId,
                title: modifiedSession?.title || commitment.title,
                start,
                end,
                resource: {
                  type: 'commitment',
                  data: {
                    ...commitment,
                    title: modifiedSession?.title || commitment.title,
                    startTime: modifiedSession?.startTime || commitment.startTime,
                    endTime: modifiedSession?.endTime || commitment.endTime,
                    type: modifiedSession?.type || commitment.type
                  }
                }
              });
            });
          }
          currentDate.setDate(currentDate.getDate() + 1);
        }
      } else {
        // Handle non-recurring commitments
        commitment.specificDates?.forEach(dateString => {
          // Skip deleted occurrences
          if (commitment.deletedOccurrences?.includes(dateString)) {
            return;
          }
          
          const currentDate = new Date(dateString);
          
          // Check for modified occurrence
          const modifiedSession = commitment.modifiedOccurrences?.[dateString];
          
          const startDateTime = new Date(currentDate);
          const [startHour, startMinute] = (modifiedSession?.startTime || commitment.startTime).split(':').map(Number);
          startDateTime.setHours(startHour, startMinute, 0, 0);
          const endDateTime = new Date(currentDate);
          const [endHour, endMinute] = (modifiedSession?.endTime || commitment.endTime).split(':').map(Number);
          endDateTime.setHours(endHour, endMinute, 0, 0);
          
          // Split if crosses midnight
          splitEventIfCrossesMidnight(startDateTime, endDateTime).forEach(({ start, end }, idx) => {
            const uniqueId = `commitment-${commitment.id}-${dateString}-${(modifiedSession?.startTime || commitment.startTime).replace(':', '')}-${idx}`;
            calendarEvents.push({
              id: uniqueId,
              title: modifiedSession?.title || commitment.title,
              start,
              end,
              resource: {
                type: 'commitment',
                data: {
                  ...commitment,
                  title: modifiedSession?.title || commitment.title,
                  startTime: modifiedSession?.startTime || commitment.startTime,
                  endTime: modifiedSession?.endTime || commitment.endTime,
                  type: modifiedSession?.type || commitment.type
                }
              }
            });
          });
        });
      }
    });

    return calendarEvents;
  }, [studyPlans, fixedCommitments, tasks]);

  // Get all unique task categories
  const taskCategories = Array.from(new Set(tasks.map(t => t.category).filter((v): v is string => !!v)));
  
  // Define all default categories with their colors
  const defaultCategories = ['Academics', 'Personal', 'Learning', 'Home', 'Finance', 'Organization', 'Work', 'Health'];
  
  // Assign color to each category with specific defaults
  const categoryColorMap: Record<string, string> = {};
  
  // Initialize all default categories with their default colors
  defaultCategories.forEach((category) => {
    switch (category.toLowerCase()) {
      case 'academics':
        categoryColorMap[category] = '#3b82f6'; // Blue
        break;
      case 'personal':
        categoryColorMap[category] = '#a21caf'; // Purple
        break;
      case 'learning':
        categoryColorMap[category] = '#a855f7'; // Lavender
        break;
      case 'home':
        categoryColorMap[category] = '#f472b6'; // Light pink
        break;
      case 'finance':
        categoryColorMap[category] = '#10b981'; // Green
        break;
      case 'organization':
        categoryColorMap[category] = '#eab308'; // Yellow
        break;
      case 'work':
        categoryColorMap[category] = '#f59e0b'; // Orange
        break;
      case 'health':
        categoryColorMap[category] = '#ef4444'; // Red
        break;
      default:
        categoryColorMap[category] = '#64748b'; // Default gray
    }
  });
  
  // Also add any custom categories from tasks that aren't in the default list
  taskCategories.forEach((category) => {
    if (!defaultCategories.includes(category)) {
      // Use palette for unknown categories
      const idx = Object.keys(categoryColorMap).length;
      categoryColorMap[category] = CATEGORY_COLORS[idx % CATEGORY_COLORS.length];
    }
  });

  const handleSelectEvent = (event: CalendarEvent) => {
    if (event.resource.type === 'study') {
      // Prevent clicking on done sessions
      if (event.resource.data.done) return;
      const today = getLocalDateString();
      // Always use planDate from event.resource.data, fallback to event.start if missing
      let planDate = event.resource.data.planDate;
      if (!planDate && event.start) {
        planDate = event.start.toISOString().split('T')[0];
      }
      if ((planDate === today)) {
        if (onSelectTask) {
          onSelectTask(event.resource.data.task, {
            allocatedHours: moment(event.end).diff(moment(event.start), 'hours', true),
            planDate: planDate,
            sessionNumber: event.resource.data.sessionNumber
          });
        }
      }
      // Otherwise, do nothing (not clickable)
    } else if (event.resource.type === 'commitment') {
      const commitment = event.resource.data as FixedCommitment;
      
      // Check if this is a manual rescheduled session
      if (commitment.type === 'other' && commitment.title.includes('(Manual Resched)')) {
        setSelectedManualSession(commitment);
      } else {
        // Handle regular commitment session management
        const targetDate = event.start.toISOString().split('T')[0];
        
        // Check if this session is deleted
        if (commitment.deletedOccurrences?.includes(targetDate)) {
          return; // Don't allow interaction with deleted sessions
        }
        
        // Check if this session is modified
        const modifiedSession = commitment.modifiedOccurrences?.[targetDate];
        
        setSelectedSessionToManage({
          commitment: {
            ...commitment,
            title: modifiedSession?.title || commitment.title,
            startTime: modifiedSession?.startTime || commitment.startTime,
            endTime: modifiedSession?.endTime || commitment.endTime,
            type: modifiedSession?.type || commitment.type
          },
          date: targetDate
        });
        setShowSessionManager(true);
      }
    }
  };

  const handleDeleteSession = (commitmentId: string, date: string) => {
    if (onDeleteCommitmentSession) {
      onDeleteCommitmentSession(commitmentId, date);
    }
    setShowSessionManager(false);
    setSelectedSessionToManage(null);
  };

  const handleEditSession = (commitmentId: string, date: string, updates: {
    startTime?: string;
    endTime?: string;
    title?: string;
    type?: 'class' | 'work' | 'appointment' | 'other' | 'buffer';
  }) => {
    if (onEditCommitmentSession) {
      onEditCommitmentSession(commitmentId, date, updates);
    }
    setShowSessionManager(false);
    setSelectedSessionToManage(null);
  };

  const handleCancelSessionManager = () => {
    setShowSessionManager(false);
    setSelectedSessionToManage(null);
  };

  // Custom event style for modern look, now color-coded by priority or type
  const eventStyleGetter = (event: CalendarEvent, start: Date, _end: Date, isSelected: boolean) => {
    let backgroundColor = COMMITMENT_DEFAULT_COLOR;
    let opacity = 0.95;
    let display = 'block';
    let textDecoration = 'none';
    let backgroundImage = 'none';
    let backgroundSize = 'auto';
    
    if (event.resource.type === 'study') {
      // Use category-based colors for study tasks
      const task = event.resource.data.task;
      if (task?.category && categoryColorMap[task.category]) {
        backgroundColor = categoryColorMap[task.category];
      } else {
        backgroundColor = colorSettings.uncategorizedTaskColor;
      }
      
      // Check session status
      const sessionStatus = checkSessionStatus(event.resource.data, moment(start).format('YYYY-MM-DD'));
      
      // Debug logging for session status
      console.log(`Calendar event "${event.title}" on ${moment(start).format('YYYY-MM-DD')}: status=${sessionStatus}, done=${event.resource.data.done}, startTime=${event.resource.data.startTime}, endTime=${event.resource.data.endTime}`);
      
      // Hide skipped sessions from calendar
      if (event.resource.data.status === 'skipped') {
        display = 'none';
        opacity = 0;
      }
      // If session is done, gray it out
      else if (event.resource.data.done || sessionStatus === 'completed') {
        backgroundColor = colorSettings.completedColor;
        opacity = 0.5;
      }
      // If session is missed, make it red and strikethrough
      else if (sessionStatus === 'missed') {
        backgroundColor = colorSettings.missedColor;
        opacity = 0.8;
        textDecoration = 'line-through';
        // Add a diagonal stripe pattern for missed sessions
        backgroundImage = 'repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255,255,255,0.1) 4px, rgba(255,255,255,0.1) 8px)';
        backgroundSize = '8px 8px';
        console.log(`Missed session "${event.title}" styled with red color and strikethrough`);
      }
      // If session is overdue, make it orange
      else if (sessionStatus === 'overdue') {
        backgroundColor = colorSettings.overdueColor;
        opacity = 0.9;
        // Add a subtle pattern for overdue sessions
        backgroundImage = 'radial-gradient(circle, rgba(255,255,255,0.2) 1px, transparent 1px)';
        backgroundSize = '4px 4px';
        console.log(`Overdue session "${event.title}" styled with orange color and dot pattern`);
      }

    } else if (event.resource.type === 'commitment') {
      const type = event.resource.data.type;
      if (type === 'buffer') {
        // Make buffer commitments invisible but still block time
        backgroundColor = 'transparent';
        opacity = 0;
        display = 'none';
      } else {
        // Use commitment color from settings
        backgroundColor = colorSettings.commitmentColor;
      }
    }
    // Add visual indicators for task importance
    let borderStyle = 'none';
    
    if (event.resource.type === 'study') {
      const task = event.resource.data.task;
      if (task && !task.importance && backgroundImage === 'none') {
        // Add more visible dot pattern for not important tasks (only if no other pattern is set)
        backgroundImage = 'radial-gradient(circle, rgba(255,255,255,0.25) 1.5px, transparent 1.5px)';
        backgroundSize = '6px 6px';
      }
      // Important tasks get no texture (clean look)
    }
    
    // Handle selection with border only
    if (isSelected) {
      borderStyle = '3px solid #a21caf';
    }
    
    return {
      style: {
        backgroundColor,
        borderRadius: '12px',
        color: '#fff',
        border: borderStyle,
        backgroundImage,
        backgroundSize: backgroundImage !== 'none' ? backgroundSize : 'auto',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        fontWeight: 500,
        fontSize: '0.95em',
        padding: '2px 8px',
        opacity,
        display,
        textDecoration,
      }
    };
  };

  // Function to get emoji for task category
  const getCategoryEmoji = (category?: string): string => {
    if (!category) return '';
    
    const categoryLower = category.toLowerCase();
    
    // Map categories to emojis
    switch (categoryLower) {
      case 'academics':
        return '📚';
      case 'org':
      case 'organization':
        return '🏢';
      case 'work':
        return '💼';
      case 'personal':
        return '👤';
      case 'health':
        return '🏥';
      case 'learning':
        return '🎓';
      case 'finance':
        return '💰';
      case 'home':
        return '🏠';
      default:
        // For custom categories, try to match common words
        if (categoryLower.includes('study') || categoryLower.includes('school') || categoryLower.includes('class')) {
          return '📚';
        } else if (categoryLower.includes('work') || categoryLower.includes('job') || categoryLower.includes('business')) {
          return '💼';
        } else if (categoryLower.includes('health') || categoryLower.includes('medical') || categoryLower.includes('fitness')) {
          return '🏥';
        } else if (categoryLower.includes('finance') || categoryLower.includes('money') || categoryLower.includes('budget')) {
          return '💰';
        } else if (categoryLower.includes('home') || categoryLower.includes('house') || categoryLower.includes('family')) {
          return '🏠';
        } else if (categoryLower.includes('personal') || categoryLower.includes('life')) {
          return '👤';
        } else {
          return '📋'; // Default for unknown categories
        }
    }
  };

  // Custom time gutter style
  const customGutterHeader = (date: Date) => moment(date).format('HH:mm');

  // Custom event component with category emoji
  const CustomEventComponent = ({ event, ...props }: any) => {
          let categoryEmoji = '';
      let statusIndicator = '';
      let duration = '';
      
      // Calculate duration more accurately
      const durationMs = moment(event.end).diff(moment(event.start));
      const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
      const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
      
      if (durationHours >= 1) {
        if (durationMinutes > 0) {
          duration = `(${durationHours}h ${durationMinutes}m)`;
        } else {
          duration = `(${durationHours}h)`;
        }
      } else {
        duration = `(${durationMinutes}m)`;
      }
      
      if (event.resource.type === 'study') {
      const task = event.resource.data.task;
      categoryEmoji = getCategoryEmoji(task?.category);
      
      // Add status indicators for missed/overdue sessions
      const sessionStatus = checkSessionStatus(event.resource.data, moment(event.start).format('YYYY-MM-DD'));
      if (sessionStatus === 'missed') {
        statusIndicator = '❌'; // Red X for missed
      } else if (sessionStatus === 'overdue') {
        statusIndicator = '⏰'; // Clock for overdue
      }
      
      // Debug logging for calendar event status
      console.log(`Calendar event "${event.title}" status: ${sessionStatus}, indicator: ${statusIndicator}`);
    } else if (event.resource.type === 'commitment') {
      const commitment = event.resource.data as FixedCommitment;
      // For commitments, use type-based emojis
      switch (commitment.type) {
        case 'class':
          categoryEmoji = '🎓';
          break;
        case 'work':
          categoryEmoji = '💼';
          break;
        case 'appointment':
          categoryEmoji = '👤';
          break;
        case 'other':
          categoryEmoji = '📅';
          break;
        default:
          categoryEmoji = '📅';
      }
    }

    return (
      <div className="relative w-full h-full" {...props}>
        {/* Main event content with emoji */}
        <div className="w-full h-full flex items-start justify-center text-center px-1 py-1 pt-1">
          <div className="flex items-center gap-1">
            {categoryEmoji && (
              <span className="text-sm">{categoryEmoji}</span>
            )}
                          <span className="text-sm font-medium leading-tight">
                {event.title} {duration}
              </span>
            {statusIndicator && (
              <span className="text-xs ml-1">{statusIndicator}</span>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Custom toolbar for interval selector
  function CustomToolbar({ label, onNavigate, onView, view }: any) {
    return (
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-2">
          <button onClick={() => onNavigate('PREV')} className="rounded-full p-2 hover:bg-gray-100 dark:hover:bg-gray-800">
            <span className="sr-only">Previous</span>
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <span className="font-semibold text-lg text-gray-800 dark:text-gray-100">{label}</span>
          <button onClick={() => onNavigate('NEXT')} className="rounded-full p-2 hover:bg-gray-100 dark:hover:bg-gray-800">
            <span className="sr-only">Next</span>
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
        <div className="flex items-center space-x-2">
          <select
            value={timeInterval}
            onChange={e => setTimeInterval(Number(e.target.value))}
            className="border rounded-lg px-2 py-1 text-sm shadow-sm focus:ring-2 focus:ring-blue-400 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
            style={{ minWidth: 80 }}
          >
            {intervalOptions.map(opt => (
              <option key={opt.value} value={opt.value} className="dark:bg-gray-800 dark:text-gray-100">{opt.label}</option>
            ))}
          </select>
          <button
            onClick={() => onView('day')}
            className={`px-2 py-1 rounded-lg text-sm font-medium ${view === 'day' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'}`}
          >Day</button>
          <button
            onClick={() => onView('week')}
            className={`px-2 py-1 rounded-lg text-sm font-medium ${view === 'week' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'}`}
          >Week</button>
          <button
            onClick={() => onView('month')}
            className={`px-2 py-1 rounded-lg text-sm font-medium ${view === 'month' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'}`}
          >Month</button>
        </div>
      </div>
    );
  }

  // Calculate min/max for zoom effect - consistent full day view
  let minTime: Date, maxTime: Date;
  // All intervals show the same full day range - extended to show all commitments
    minTime = new Date(0, 0, 0, 4, 0, 0);  // 4 AM
    maxTime = new Date(0, 0, 0, 23, 59, 0);  // 11:59 PM (just before midnight)

  // If mobile, render the mobile calendar component
  if (isMobile) {
    return (
      <MobileCalendarView
        studyPlans={studyPlans}
        fixedCommitments={fixedCommitments}
        tasks={tasks}
        onSelectTask={onSelectTask}
        onStartManualSession={onStartManualSession}
        onDeleteFixedCommitment={onDeleteFixedCommitment}
        onDeleteCommitmentSession={onDeleteCommitmentSession}
        onEditCommitmentSession={onEditCommitmentSession}
      />
    );
  }

  return (
    <div className="bg-gradient-to-br from-blue-50 via-white to-purple-50 rounded-2xl shadow-xl p-6 dark:from-gray-900 dark:via-gray-950 dark:to-gray-900 dark:shadow-gray-900 dark:text-gray-100">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center space-x-2 dark:text-white">
          <BookOpen className="text-blue-600 dark:text-blue-400" size={28} />
          <span>Smart Calendar</span>
        </h2>
        <button
          onClick={() => setShowColorSettings(true)}
          className="p-2 rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors"
          title="Customize Colors"
        >
          <Settings size={20} className="text-gray-600 dark:text-gray-300" />
        </button>
      </div>
      {/* Legends */}
      <div className="mb-4 flex flex-wrap gap-4">
        {/* Task Category Legends */}
        {taskCategories.map(category => (
          <div key={category} className="flex items-center space-x-2">
            <span style={{ background: categoryColorMap[category], width: 16, height: 16, borderRadius: '50%', display: 'inline-block', border: '2px solid #fff', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}></span>
            <span className="text-sm text-gray-700 font-medium dark:text-gray-300 capitalize">{category}</span>
        </div>
        ))}
        {/* Default Category Legends (for categories not yet used) */}
        {['Academics', 'Personal', 'Learning', 'Home', 'Finance', 'Organization', 'Work', 'Health'].filter(category => !taskCategories.includes(category)).map(category => {
          let color = '#64748b'; // Default gray
          switch (category.toLowerCase()) {
            case 'academics':
              color = '#3b82f6'; // Blue
              break;
            case 'personal':
              color = '#a21caf'; // Purple
              break;
            case 'learning':
              color = '#a855f7'; // Lavender
              break;
            case 'home':
              color = '#f472b6'; // Light pink
              break;
            case 'finance':
              color = '#10b981'; // Green
              break;
            case 'organization':
              color = '#eab308'; // Yellow
              break;
            case 'work':
              color = '#f59e0b'; // Orange
              break;
            case 'health':
              color = '#ef4444'; // Red
              break;
          }
          return (
            <div key={category} className="flex items-center space-x-2">
              <span style={{ background: color, width: 16, height: 16, borderRadius: '50%', display: 'inline-block', border: '2px solid #fff', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}></span>
              <span className="text-sm text-gray-700 font-medium dark:text-gray-300 capitalize">{category}</span>
            </div>
          );
        })}
        {/* Commitment Legend */}
        <div className="flex items-center space-x-2">
          <span style={{ background: colorSettings.commitmentColor, width: 16, height: 16, borderRadius: '50%', display: 'inline-block', border: '2px solid #fff', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}></span>
          <span className="text-sm text-gray-700 font-medium dark:text-gray-300">Commitments</span>
        </div>
      </div>
      <div
        style={{
          height: '650px',
          borderRadius: '1.5rem',
          overflow: 'hidden',
          background: 'rgba(255,255,255,0.95)',
          boxShadow: '0 4px 24px rgba(80,80,180,0.07)',
        }}
        className="calendar-grid-container dark:bg-gray-900 dark:bg-opacity-95"
      >
        <Calendar
          localizer={localizer}
          events={events}
          startAccessor="start"
          endAccessor="end"
          style={{ height: '100%' }}
          views={[Views.MONTH, Views.WEEK, Views.DAY]}
          defaultView={Views.WEEK}
          step={timeInterval}
          timeslots={
            timeInterval === 5 ? 12 :
            timeInterval === 10 ? 6 :
            timeInterval === 15 ? 4 :
            timeInterval === 30 ? 2 :
            1
          }
          min={minTime}
          max={maxTime}
          onSelectEvent={handleSelectEvent}
          eventPropGetter={eventStyleGetter}
          formats={{
            timeGutterFormat: customGutterHeader,
            eventTimeRangeFormat: ({ start, end }) =>
              `${moment(start).format('HH:mm')} - ${moment(end).format('HH:mm')}`
          }}
          components={{
            toolbar: CustomToolbar,
            event: CustomEventComponent
          }}
          rtl={false}
          dayLayoutAlgorithm="no-overlap"
        />
      </div>
      {/* Add custom CSS for thicker interval lines and better spacing */}
      <style>{`
        .rbc-time-slot {
          border-bottom: 2px solid #e0e7ef !important;
        }
        .dark .calendar-grid-container {
          background: rgba(24,24,27,0.95) !important;
        }
        .dark .rbc-time-slot {
          border-bottom: 2px solid #27272a !important;
        }
        .dark .rbc-month-row, .dark .rbc-month-view, .dark .rbc-header, .dark .rbc-time-header, .dark .rbc-timeslot-group, .dark .rbc-time-content {
          background-color: #18181b !important;
        }
        .dark .rbc-date-cell, .dark .rbc-day-bg {
          background-color: #18181b !important;
        }
        .dark .rbc-off-range-bg {
          background-color: #23232a !important;
        }
        .dark .rbc-current {
          background-color: #334155 !important;
        }
        .dark .rbc-label, .dark .rbc-header, .dark .rbc-date-cell, .dark .rbc-timeslot-group, .dark .rbc-time-gutter, .dark .rbc-time-header-content {
          color: #e5e7eb !important;
        }
        
        /* Dynamic spacing based on interval size */
        .rbc-time-view .rbc-timeslot-group {
          min-height: 24px !important;
        }
        
        /* Zoom-based time slot heights */
        .rbc-time-slot {
          min-height: 24px !important;
        }
        
        /* More distinct hour grid lines */
        .rbc-time-slot:first-child {
          border-top: 3px solid #d1d5db !important;
        }
        
        .rbc-time-slot:not(:first-child) {
          border-top: 1px solid #e5e7eb !important;
        }
        
        /* Dark mode hour grid lines */
        .dark .rbc-time-slot:first-child {
          border-top: 3px solid #4b5563 !important;
        }
        
        .dark .rbc-time-slot:not(:first-child) {
          border-top: 1px solid #374151 !important;
        }
        
        /* Ensure events have minimum height for readability */
        .rbc-event {
          min-height: 22px !important;
          min-width: 60px !important;
        }
        
        /* Better text sizing for event blocks */
        .rbc-event .text-sm {
          font-size: 12px !important;
          line-height: 1.3 !important;
        }
        
        /* Enhanced time gutter for zoomed views */
        .rbc-time-gutter {
          min-width: 60px !important;
          font-weight: 500 !important;
        }
        
        /* Better visual separation for zoomed intervals */
        .rbc-time-header-content {
          border-bottom: 2px solid #e0e7ef !important;
        }
        
        .dark .rbc-time-header-content {
          border-bottom: 2px solid #27272a !important;
        }
        
        /* Darker styling for past days */
        .rbc-day-bg.rbc-off-range {
          background-color: #f8f9fa !important;
        }
        
        .rbc-day-bg.rbc-off-range.rbc-past {
          background-color: #e9ecef !important;
        }
        
        .rbc-day-bg.rbc-past {
          background-color: #f1f3f4 !important;
        }
        
        /* Dark mode past days */
        .dark .rbc-day-bg.rbc-off-range {
          background-color: #1f2937 !important;
        }
        
        .dark .rbc-day-bg.rbc-off-range.rbc-past {
          background-color: #111827 !important;
        }
        
        .dark .rbc-day-bg.rbc-past {
          background-color: #1e293b !important;
        }
        
        /* Past time slots in time view */
        .rbc-timeslot-group.rbc-past {
          background-color: #f8f9fa !important;
        }
        
        .dark .rbc-timeslot-group.rbc-past {
          background-color: #1f2937 !important;
        }
      `}</style>

      {/* Color Settings Modal */}
      {showColorSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-6 calendar-toolbar">
                <h2 className="text-2xl font-bold text-gray-800 dark:text-white">
                  Customize Calendar Colors
                </h2>
                <button
                  onClick={() => setShowColorSettings(false)}
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <X size={24} />
                </button>
              </div>

              <div className="space-y-6">
                {/* Task Category Colors */}
                <div>
                  <h3 className="text-lg font-semibold text-gray-800 dark:text-white mb-4">Task Category Colors</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* All default categories */}
                    {['Academics', 'Personal', 'Learning', 'Home', 'Finance', 'Organization', 'Work', 'Health'].map(category => {
                      let defaultColor = '#64748b';
                      switch (category.toLowerCase()) {
                        case 'academics':
                          defaultColor = '#3b82f6'; // Blue
                          break;
                        case 'personal':
                          defaultColor = '#a21caf'; // Purple
                          break;
                        case 'learning':
                          defaultColor = '#a855f7'; // Lavender
                          break;
                        case 'home':
                          defaultColor = '#f472b6'; // Light pink
                          break;
                        case 'finance':
                          defaultColor = '#10b981'; // Green
                          break;
                        case 'organization':
                          defaultColor = '#eab308'; // Yellow
                          break;
                        case 'work':
                          defaultColor = '#f59e0b'; // Orange
                          break;
                        case 'health':
                          defaultColor = '#ef4444'; // Red
                          break;
                      }
                      return (
                        <div key={category} className="flex items-center space-x-3">
                          <input
                            type="color"
                            value={categoryColorMap[category] || defaultColor}
                            onChange={(e) => {
                              // Update the category color map
                              const newColorMap = { ...categoryColorMap };
                              newColorMap[category] = e.target.value;
                              // Note: This would need to be persisted if you want to save custom colors
                            }}
                            className="w-12 h-8 rounded border border-gray-300 dark:border-gray-600"
                          />
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 capitalize">
                            {category}
                          </span>
                        </div>
                      );
                    })}
                    {/* Uncategorized tasks */}
                    <div className="flex items-center space-x-3">
                      <input
                        type="color"
                        value={colorSettings.uncategorizedTaskColor}
                        onChange={(e) => handleSpecialColorChange('uncategorizedTaskColor', e.target.value)}
                        className="w-12 h-8 rounded border border-gray-300 dark:border-gray-600"
                      />
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Uncategorized
                      </span>
                    </div>
                  </div>
                </div>

                {/* Commitment Color */}
                <div>
                  <h3 className="text-lg font-semibold text-gray-800 dark:text-white mb-4">Commitment Color</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex items-center space-x-3">
                      <input
                        type="color"
                        value={colorSettings.commitmentColor}
                        onChange={(e) => handleSpecialColorChange('commitmentColor', e.target.value)}
                        className="w-12 h-8 rounded border border-gray-300 dark:border-gray-600"
                      />
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        All Commitments
                      </span>
                    </div>
                  </div>
                </div>

                {/* Special Status Colors */}
                <div>
                  <h3 className="text-lg font-semibold text-gray-800 dark:text-white mb-4">Special Status Colors</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                    <div className="flex items-center space-x-3">
                      <input
                        type="color"
                        value={colorSettings.missedColor}
                        onChange={(e) => handleSpecialColorChange('missedColor', e.target.value)}
                        className="w-12 h-8 rounded border border-gray-300 dark:border-gray-600"
                      />
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Missed
                      </span>
                    </div>
                    <div className="flex items-center space-x-3">
                      <input
                        type="color"
                        value={colorSettings.overdueColor}
                        onChange={(e) => handleSpecialColorChange('overdueColor', e.target.value)}
                        className="w-12 h-8 rounded border border-gray-300 dark:border-gray-600"
                      />
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Overdue
                      </span>
                    </div>
                    <div className="flex items-center space-x-3">
                      <input
                        type="color"
                        value={colorSettings.completedColor}
                        onChange={(e) => handleSpecialColorChange('completedColor', e.target.value)}
                        className="w-12 h-8 rounded border border-gray-300 dark:border-gray-600"
                      />
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Completed
                      </span>
                    </div>
                  </div>
                </div>



                {/* Action Buttons */}
                <div className="flex justify-between pt-4 border-t border-gray-200 dark:border-gray-700">
                  <button
                    onClick={resetToDefaults}
                    className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 transition-colors"
                  >
                    Reset to Defaults
                  </button>
                  <button
                    onClick={() => setShowColorSettings(false)}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add modal for manual session */}
      {selectedManualSession && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-md w-full mx-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-800 dark:text-white flex items-center space-x-2">
                  <Clock className="text-blue-500" size={24} />
                  <span>Manual Rescheduled Session</span>
                </h2>
                <button
                  onClick={() => setSelectedManualSession(null)}
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <X size={24} />
                </button>
              </div>
              <div className="mb-4">
                <div className="font-semibold text-gray-700 dark:text-gray-200 mb-1">{selectedManualSession.title}</div>
                <div className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                  {selectedManualSession.startTime} - {selectedManualSession.endTime}
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                  Duration: {(() => {
                    const [sh, sm] = selectedManualSession.startTime.split(":").map(Number);
                    const [eh, em] = selectedManualSession.endTime.split(":").map(Number);
                    let mins = (eh * 60 + em) - (sh * 60 + sm);
                    if (mins < 0) mins += 24 * 60;
                    return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
                  })()}
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => {
                    // Start session (redirect to timer)
                    if (onStartManualSession) {
                      const [sh, sm] = selectedManualSession.startTime.split(":").map(Number);
                      const [eh, em] = selectedManualSession.endTime.split(":").map(Number);
                      let mins = (eh * 60 + em) - (sh * 60 + sm);
                      if (mins < 0) mins += 24 * 60;
                      setSelectedManualSession(null);
                      onStartManualSession(selectedManualSession, mins * 60);
                    } else {
                      setSelectedManualSession(null);
                    }
                  }}
                  className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
                >
                  Start Session
                </button>
                <button
                  onClick={() => {
                    if (onDeleteFixedCommitment) {
                      onDeleteFixedCommitment(selectedManualSession.id);
                    }
                    setSelectedManualSession(null);
                  }}
                  className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                >
                  Delete Session
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Session Manager Modal */}
      {showSessionManager && selectedSessionToManage && (
        <CommitmentSessionManager
          commitment={selectedSessionToManage.commitment}
          targetDate={selectedSessionToManage.date}
          onDeleteSession={handleDeleteSession}
          onEditSession={handleEditSession}
          onCancel={handleCancelSessionManager}
        />
      )}
    </div>
  );
};

export default CalendarView;

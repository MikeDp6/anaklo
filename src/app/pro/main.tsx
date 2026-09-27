import '@fontsource-variable/manrope'
import '@/styles/tokens.css'
import '@/styles/base.css'
import { RouterProvider } from 'react-router/dom'
import { mount } from '../shared/mount'
import { router } from './router'

await mount(<RouterProvider router={router} />)
